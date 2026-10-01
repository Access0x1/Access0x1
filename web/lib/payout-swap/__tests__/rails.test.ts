/**
 * @file rails.test.ts — offline unit tests for the three rail clients (mocked transport/SDK).
 *
 * Each rail implements the same {@link PayoutSwapClient} shape. Tests mock the Trading API
 * fetch / RPC submit / App Kit SDK so the request shaping, error surfacing, customFee=0
 * (law #4), gasless-vs-classic route choice, and Blink-recovery fallback (law #5) are pinned
 * with zero network. Driven end-to-end through {@link runPayoutSwap} where it matters.
 */
import { describe, expect, it, vi } from 'vitest'
import { baseSepolia, zksync } from 'viem/chains'

import { runPayoutSwap } from '../worker.js'
import {
  createUniswapTradingApiClient,
  type FetchLike,
} from '../rails/uniswapTradingApi.js'
import { createUniswapClassicClient } from '../rails/uniswapClassic.js'
import { createCircleAppKitClient, type AppKitSwapSdk } from '../rails/circleAppKit.js'
import type { SwapRequest } from '../types.js'

const USDC = '0x1111111111111111111111111111111111111111' as const
const PAYOUT = '0x2222222222222222222222222222222222222222' as const
const MERCHANT = '0x3333333333333333333333333333333333333333' as const

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function baseReq(over: Partial<SwapRequest> = {}): SwapRequest {
  return {
    chainId: baseSepolia.id,
    usdc: USDC,
    payoutToken: PAYOUT,
    merchant: MERCHANT,
    amountUsdc: 1_000_000n,
    minAmountOut: 990_000n,
    ...over,
  }
}

describe('Uniswap Trading API rail (Base)', () => {
  // Canonical mock responses (live-verified shapes, 2026-07-25): CLASSIC nests the output on
  // `quote.output`; UniswapX carries a Dutch-auction order with start/end amounts instead.
  const classicQuote = (amount = '995000') => ({
    routing: 'CLASSIC',
    quote: { output: { token: PAYOUT, amount } },
    permitData: null,
  })
  const dutchQuote = (endAmount = '995000', startAmount = '999000') => ({
    routing: 'DUTCH_V2',
    quote: { orderInfo: { outputs: [{ startAmount, endAmount }] } },
    permitData: { domain: {} },
  })
  const swapTx = () => ({
    swap: { to: '0xrouter', from: MERCHANT, data: '0xcafe', value: '0', chainId: 84532 },
  })

  it('a UniswapX quote routes to /order with the quote spread in (permitData stripped)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith('/quote')) return json(dutchQuote())
      if (url.endsWith('/order')) return json({ txHash: '0xorder' })
      return json({ error: 'unexpected' }, 500)
    })
    const client = createUniswapTradingApiClient({ baseUrl: 'https://api', fetchImpl })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.swapped).toBe(true)
    expect(res.txHash).toBe('0xorder')
    // The documented execute body: the quote response fields spread in — never wrapped,
    // never re-fetched — with permitData stripped (the wallet owner signs permits).
    const orderCall = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith('/order'))!
    const body = JSON.parse((orderCall[1] as RequestInit).body as string)
    expect(body.routing).toBe('DUTCH_V2')
    expect(body.quote).toBeDefined()
    expect(body.permitData).toBeUndefined()
  })

  it('UniswapX slippage uses the auction FLOOR (endAmount) — a decaying fill cannot sneak past', async () => {
    // startAmount clears the 990000 floor; endAmount does not. The floor must win.
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith('/quote')) return json(dutchQuote('980000', '999000'))
      return json({ error: 'unexpected' }, 500)
    })
    const client = createUniswapTradingApiClient({ baseUrl: 'https://api', fetchImpl })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('slippage-exceeded')
  })

  it('the default (gasless) mode leaves routing unrestricted so UniswapX can win', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(classicQuote()))
    const client = createUniswapTradingApiClient({ baseUrl: 'https://api', fetchImpl })
    await client.quote(baseReq())
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.routingPreference).toBe('BEST_PRICE')
    // No `protocols` key at all: naming any would narrow the search away from UniswapX.
    expect('protocols' in body).toBe(false)
  })

  it('classic mode restricts the quote to AMM protocols and surfaces the ready-to-sign /swap tx', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith('/quote')) return json(classicQuote())
      if (url.endsWith('/swap')) return json(swapTx())
      return json({ error: 'unexpected' }, 500)
    })
    const client = createUniswapTradingApiClient({
      baseUrl: 'https://api',
      fetchImpl,
      preferGasless: false,
    })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.swapped).toBe(true)
    // /swap answers with an UNSIGNED transaction — the merchant wallet signs + submits.
    expect(res.txHash).toBeUndefined()
    expect(res.unsignedTx).toMatchObject({ to: '0xrouter', data: '0xcafe' })
    // classic mode keeps the quote /swap-able by naming only AMM protocols. The old
    // `routingPreference: 'CLASSIC'` is retired: the live API answers it with HTTP 400
    // `"routingPreference" must be one of [BEST_PRICE, FASTEST]` (probed 2026-10-01).
    const quoteCall = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith('/quote'))!
    const body = JSON.parse((quoteCall[1] as RequestInit).body as string)
    expect(body.routingPreference).toBe('BEST_PRICE')
    expect(body.protocols).toEqual(['V2', 'V3', 'V4'])
    expect(body.tokenInChainId).toBe(String(baseSepolia.id))
    expect(body.amount).toBe('1000000')
    expect(body.type).toBe('EXACT_INPUT')
  })

  it('an expired /swap (empty calldata) is rejected, never surfaced as executable', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith('/quote')) return json(classicQuote())
      if (url.endsWith('/swap')) return json({ swap: { to: '0xrouter', data: '0x' } })
      return json({ error: 'unexpected' }, 500)
    })
    const client = createUniswapTradingApiClient({
      baseUrl: 'https://api',
      fetchImpl,
      preferGasless: false,
    })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('execute-failed')
  })

  it('a non-ok /quote surfaces as quote-failed (never blocks)', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'down' }, 503))
    const client = createUniswapTradingApiClient({ baseUrl: 'https://api', fetchImpl })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.reason).toBe('quote-failed')
  })

  it('checkApproval: returns the ready-to-sign approval tx when the API says one is needed', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (url.endsWith('/check_approval')) {
        const body = JSON.parse((init as RequestInit).body as string)
        // Field names verified against @uniswap/client-trading@0.5.15.
        expect(body).toMatchObject({
          walletAddress: MERCHANT,
          token: USDC,
          amount: '1000000',
          chainId: baseSepolia.id,
        })
        return json({ requestId: 'r1', approval: { to: '0xperm', data: '0xdead' } })
      }
      return json({ error: 'unexpected' }, 500)
    })
    const client = createUniswapTradingApiClient({ baseUrl: 'https://api', fetchImpl })
    const check = await client.checkApproval!(baseReq())
    expect(check.needed).toBe(true)
    expect(check.approval).toMatchObject({ to: '0xperm', data: '0xdead' })
  })

  it('checkApproval: absent approval field means already approved (needed=false)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ requestId: 'r2' }))
    const client = createUniswapTradingApiClient({ baseUrl: 'https://api', fetchImpl })
    const check = await client.checkApproval!(baseReq())
    expect(check).toEqual({ needed: false, approval: null })
  })

  it('checkApproval: a non-ok response throws (the caller isolates it)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: 'down' }, 502))
    const client = createUniswapTradingApiClient({ baseUrl: 'https://api', fetchImpl })
    await expect(client.checkApproval!(baseReq())).rejects.toThrow('/check_approval failed (502)')
  })

  it('the three execution modes land on /order, /swap, /swap_7702 (business/user/agent)', async () => {
    // The endpoint follows the QUOTE's routing (the official rule); smart-account overrides
    // to /swap_7702. gasless gets a UniswapX quote, the other two a CLASSIC one.
    for (const [mode, quoteBody, path] of [
      ['gasless', dutchQuote(), '/order'],
      ['classic', classicQuote(), '/swap'],
      ['smart-account', classicQuote(), '/swap_7702'],
    ] as const) {
      const fetchImpl = vi.fn<FetchLike>(async (url) => {
        if (url.endsWith('/quote')) return json(quoteBody)
        if (url.endsWith(path)) return json({ txHash: `0x${mode}` })
        return json({ error: `unexpected ${url}` }, 500)
      })
      const client = createUniswapTradingApiClient({
        baseUrl: 'https://api',
        fetchImpl,
        executionMode: mode,
      })
      const quote = await client.quote(baseReq())
      const exec = await client.execute(baseReq(), quote)
      expect(exec.txHash).toBe(`0x${mode}`)
    }
  })
})

// DRIVEN AT THE CLIENT, NOT THROUGH runPayoutSwap, for the same reason as oneInch.test.ts. These
// tests used to run the worker against zkSync Sepolia, which required the capability table to map
// chain 300 to this rail. The Trading API does not accept chain id 300 (live 400, 2026-10-01), so
// that mapping is gone and no chain resolves to this rail today. The request below uses zkSync
// Era's own id (324), the chain the API does accept and the only one this client could serve.
// The worker's isolation of a throwing execute stays covered by the Trading API suite above.
describe('Uniswap classic rail (zkSync) + Blink Recovery', () => {
  function zkReq() {
    return baseReq({ chainId: zksync.id })
  }
  /** quote → execute, exactly the order the worker runs them in. */
  async function swap(client: ReturnType<typeof createUniswapClassicClient>) {
    return client.execute(zkReq(), await client.quote(zkReq()))
  }
  const swapFetch = () =>
    vi.fn(async (url: string) => {
      if (url.endsWith('/quote'))
        return json({ routing: 'CLASSIC', quote: { output: { amount: '995000' } } })
      if (url.endsWith('/swap')) return json({ amountOut: '995000', rawTx: '0xraw' })
      return json({ error: 'unexpected' }, 500)
    })

  it('quotes AMM-only with the accepted routing fields (never the retired CLASSIC preference)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      json({ routing: 'CLASSIC', quote: { output: { amount: '995000' } } }),
    )
    const client = createUniswapClassicClient({
      baseUrl: 'https://api',
      fetchImpl,
      submitDirect: vi.fn(async () => '0xdirect'),
    })
    await client.quote(zkReq())
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.routingPreference).toBe('BEST_PRICE')
    expect(body.protocols).toEqual(['V2', 'V3', 'V4'])
  })

  it('submits via direct RPC when Blink is not configured', async () => {
    const submitDirect = vi.fn(async () => '0xdirect')
    const client = createUniswapClassicClient({
      baseUrl: 'https://api',
      fetchImpl: swapFetch(),
      submitDirect,
    })
    const res = await swap(client)
    expect(res.txHash).toBe('0xdirect')
    expect(submitDirect).toHaveBeenCalledWith('0xraw')
  })

  it('prefers Blink Recovery RPC when configured', async () => {
    const submitDirect = vi.fn(async () => '0xdirect')
    const submitBlink = vi.fn(async () => '0xblink')
    const client = createUniswapClassicClient({
      baseUrl: 'https://api',
      fetchImpl: swapFetch(),
      submitDirect,
      submitBlink,
    })
    const res = await swap(client)
    expect(res.txHash).toBe('0xblink')
    expect(submitDirect).not.toHaveBeenCalled()
  })

  it('Blink liveness failure falls back to direct RPC — swap still lands (recovery is best-effort)', async () => {
    const submitDirect = vi.fn(async () => '0xdirect')
    const submitBlink = vi.fn(async () => {
      throw new Error('blink offline')
    })
    const client = createUniswapClassicClient({
      baseUrl: 'https://api',
      fetchImpl: swapFetch(),
      submitDirect,
      submitBlink,
    })
    const res = await swap(client)
    expect(res.rail).toBe('uniswap-classic')
    expect(res.txHash).toBe('0xdirect')
    expect(submitBlink).toHaveBeenCalledOnce()
    expect(submitDirect).toHaveBeenCalledOnce()
  })

  it('if BOTH Blink and direct fail, execute rejects with the direct error (the worker isolates it)', async () => {
    const client = createUniswapClassicClient({
      baseUrl: 'https://api',
      fetchImpl: swapFetch(),
      submitDirect: async () => {
        throw new Error('rpc down')
      },
      submitBlink: async () => {
        throw new Error('blink down')
      },
    })
    // The Blink error is swallowed in favour of the direct submit; the direct error is the one
    // that surfaces. Nothing is reported as landed.
    await expect(swap(client)).rejects.toThrow('rpc down')
  })
})

describe('Circle App Kit rail (Arc)', () => {
  it('quotes + executes with customFee=0 (App Kit no double-charge, law #4)', async () => {
    const executeSwap = vi.fn(async () => ({ transactionHash: '0xarc' }))
    const sdk: AppKitSwapSdk = {
      getSwapQuote: vi.fn(async () => ({ amountOut: '995000', quoteHandle: 'h1' })),
      executeSwap,
    }
    const client = createCircleAppKitClient(sdk)
    const res = await client.execute(
      baseReq(),
      await client.quote(baseReq()),
    )
    expect(res.txHash).toBe('0xarc')
    expect(executeSwap).toHaveBeenCalledWith(expect.objectContaining({ customFee: 0, quoteHandle: 'h1' }))
  })

  it('honest fallback: a no-liquidity quote rejection surfaces (worker would degrade to direct USDC)', async () => {
    const sdk: AppKitSwapSdk = {
      getSwapQuote: vi.fn(async () => {
        throw new Error('no routable Arc liquidity for USDC->Y')
      }),
      executeSwap: vi.fn(),
    }
    const client = createCircleAppKitClient(sdk)
    await expect(client.quote(baseReq())).rejects.toThrow(/liquidity/)
  })
})
