/**
 * @file rails.test.ts — offline unit tests for the three rail clients (mocked transport/SDK).
 *
 * Each rail implements the same {@link PayoutSwapClient} shape. Tests mock the Trading API
 * fetch / RPC submit / App Kit SDK so the request shaping, error surfacing, customFee=0
 * (law #4), gasless-vs-classic route choice, and Blink-recovery fallback (law #5) are pinned
 * with zero network. Driven end-to-end through {@link runPayoutSwap} where it matters.
 */
import { describe, expect, it, vi } from 'vitest'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'

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
  it('quote then gasless /order by default, customFee=0', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith('/quote')) return json({ amountOut: '995000', quoteId: 'q1' })
      if (url.endsWith('/order')) return json({ txHash: '0xorder' })
      return json({ error: 'unexpected' }, 500)
    })
    const client = createUniswapTradingApiClient({ baseUrl: 'https://api', fetchImpl })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.swapped).toBe(true)
    expect(res.txHash).toBe('0xorder')
    // The order body carries customFeeBps: 0 (sole monetization is the router fee-split).
    const orderCall = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith('/order'))!
    const body = JSON.parse((orderCall[1] as RequestInit).body as string)
    expect(body.customFeeBps).toBe(0)
    expect(body.minAmountOut).toBe('990000')
  })

  it('preferGasless=false uses classic /swap', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/quote')) return json({ amountOut: '995000', quoteId: 'q1' })
      if (url.endsWith('/swap')) return json({ txHash: '0xswap' })
      return json({ error: 'unexpected' }, 500)
    })
    const client = createUniswapTradingApiClient({
      baseUrl: 'https://api',
      fetchImpl,
      preferGasless: false,
    })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.txHash).toBe('0xswap')
  })

  it('a non-ok /quote surfaces as quote-failed (never blocks)', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'down' }, 503))
    const client = createUniswapTradingApiClient({ baseUrl: 'https://api', fetchImpl })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.reason).toBe('quote-failed')
  })
})

describe('Uniswap classic rail (zkSync) + Blink Recovery', () => {
  function zkReq() {
    return baseReq({ chainId: zksyncSepoliaTestnet.id })
  }
  const swapFetch = () =>
    vi.fn(async (url: string) => {
      if (url.endsWith('/quote')) return json({ amountOut: '995000' })
      if (url.endsWith('/swap')) return json({ amountOut: '995000', rawTx: '0xraw' })
      return json({ error: 'unexpected' }, 500)
    })

  it('submits via direct RPC when Blink is not configured', async () => {
    const submitDirect = vi.fn(async () => '0xdirect')
    const client = createUniswapClassicClient({
      baseUrl: 'https://api',
      fetchImpl: swapFetch(),
      submitDirect,
    })
    const res = await runPayoutSwap(zkReq(), client)
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
    const res = await runPayoutSwap(zkReq(), client)
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
    const res = await runPayoutSwap(zkReq(), client)
    expect(res.swapped).toBe(true)
    expect(res.txHash).toBe('0xdirect')
    expect(submitBlink).toHaveBeenCalledOnce()
    expect(submitDirect).toHaveBeenCalledOnce()
  })

  it('if BOTH Blink and direct fail, the worker isolates it as execute-failed (USDC stays)', async () => {
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
    const res = await runPayoutSwap(zkReq(), client)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('execute-failed')
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
