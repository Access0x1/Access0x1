/**
 * @file oneInch.test.ts — offline unit tests for the 1inch aggregator rail (mocked transport).
 *
 * Pins the request shaping, the gasless-Fusion vs classic-/swap route choice, the zero integrator
 * fee (fee=0, law #4), and error surfacing — with zero network.
 *
 * DRIVEN AT THE CLIENT, NOT THROUGH {@link runPayoutSwap}, and deliberately so. These tests used to
 * run the worker against Polygon Amoy, because the capability table mapped Amoy to 1inch. That
 * mapping was removed: 1inch's API serves NO testnets (this repo says so itself in
 * lib/config/integrations.ts), so the table was promising a swap that could never execute, on a
 * chain with no broadcast record either.
 *
 * Testing through the worker therefore required the false mapping to exist — the test was holding a
 * fiction in place. Exercising the client directly keeps every real assertion (request shape, fee=0,
 * route choice, error propagation) and drops only the part that was pretending. The worker's own
 * isolation logic — quote-failed, slippage-exceeded, chain-not-capable — is chain-agnostic and stays
 * covered by the Uniswap rail suites.
 */
import { describe, expect, it, vi } from 'vitest'
import { polygonAmoy } from 'viem/chains'

import { createOneInchClient } from '../rails/oneInch.js'
import type { FetchLike } from '../rails/uniswapTradingApi.js'
import type { SwapRequest } from '../types.js'

const USDC = '0x1111111111111111111111111111111111111111' as const
const PAYOUT = '0x2222222222222222222222222222222222222222' as const
const MERCHANT = '0x3333333333333333333333333333333333333333' as const

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function baseReq(over: Partial<SwapRequest> = {}): SwapRequest {
  return {
    chainId: polygonAmoy.id,
    usdc: USDC,
    payoutToken: PAYOUT,
    merchant: MERCHANT,
    amountUsdc: 1_000_000n,
    minAmountOut: 990_000n,
    ...over,
  }
}

describe('1inch aggregator rail', () => {
  it('quotes, then executes gasless Fusion by default, with fee=0 on every leg', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('/quote')) return json({ dstAmount: '995000' })
      if (url.includes('/fusion/orders')) return json({ txHash: '0xfusion' })
      return json({ error: 'unexpected' }, 500)
    })
    const client = createOneInchClient({ baseUrl: 'https://api', fetchImpl })
    const req = baseReq()

    const quote = await client.quote(req)
    expect(quote.amountOut).toBe(995_000n)

    const exec = await client.execute(req, quote)
    expect(client.rail).toBe('one-inch')
    expect(exec.txHash).toBe('0xfusion')

    // Both legs carry the zero integrator fee (sole monetization is the router fee-split).
    for (const call of fetchImpl.mock.calls) {
      expect(new URL(String(call[0])).searchParams.get('fee')).toBe('0')
    }
    // The execute leg passes the slippage floor to 1inch too.
    const orderCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/fusion/orders'))!
    expect(new URL(String(orderCall[0])).searchParams.get('minReturnAmount')).toBe('990000')
  })

  it('preferFusion=false routes the execute leg to classic /swap', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('/quote')) return json({ dstAmount: '995000' })
      if (url.includes('/swap')) return json({ txHash: '0xswap' })
      return json({ error: 'unexpected' }, 500)
    })
    const client = createOneInchClient({ baseUrl: 'https://api', fetchImpl, preferFusion: false })
    const req = baseReq()
    const exec = await client.execute(req, await client.quote(req))
    expect(exec.txHash).toBe('0xswap')
  })

  it('a non-ok /quote REJECTS, so the worker can isolate it and keep the merchant in USDC', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: 'rate limited' }, 429))
    const client = createOneInchClient({ baseUrl: 'https://api', fetchImpl })
    // Rejecting (not resolving with a bad value) is the contract the worker relies on to
    // report `quote-failed` and skip the swap rather than settle against a garbage number.
    await expect(client.quote(baseReq())).rejects.toThrow()
  })

  it('reports the raw quote so the worker — not the rail — enforces the slippage floor', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('/quote')) return json({ dstAmount: '980000' }) // below the 990000 floor
      return json({ txHash: '0xnope' })
    })
    const client = createOneInchClient({ baseUrl: 'https://api', fetchImpl })
    const quote = await client.quote(baseReq())
    // The rail must NOT silently clamp or pre-reject: the floor is one rule, enforced in one
    // place (the worker), so every rail cannot drift from it independently.
    expect(quote.amountOut).toBe(980_000n)
    expect(quote.amountOut).toBeLessThan(baseReq().minAmountOut)
  })
})
