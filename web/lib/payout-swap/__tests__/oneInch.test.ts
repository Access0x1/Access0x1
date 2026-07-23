/**
 * @file oneInch.test.ts — offline unit tests for the 1inch aggregator rail (mocked transport).
 *
 * Pins the request shaping, the gasless-Fusion vs classic-/swap route choice, the zero integrator
 * fee (fee=0, law #4), and error surfacing — driven end-to-end through {@link runPayoutSwap} on
 * Polygon Amoy (the chain the capability table routes to 1inch), with zero network.
 */
import { describe, expect, it, vi } from 'vitest'
import { polygonAmoy } from 'viem/chains'

import { runPayoutSwap } from '../worker.js'
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

describe('1inch aggregator rail (Polygon)', () => {
  it('quote then gasless Fusion by default, fee=0', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('/quote')) return json({ dstAmount: '995000' })
      if (url.includes('/fusion/orders')) return json({ txHash: '0xfusion' })
      return json({ error: 'unexpected' }, 500)
    })
    const client = createOneInchClient({ baseUrl: 'https://api', fetchImpl })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.swapped).toBe(true)
    expect(res.rail).toBe('one-inch')
    expect(res.txHash).toBe('0xfusion')
    // Both legs carry the zero integrator fee (sole monetization is the router fee-split).
    for (const call of fetchImpl.mock.calls) {
      expect(new URL(String(call[0])).searchParams.get('fee')).toBe('0')
    }
    // The execute leg passes the slippage floor to 1inch too.
    const orderCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/fusion/orders'))!
    expect(new URL(String(orderCall[0])).searchParams.get('minReturnAmount')).toBe('990000')
  })

  it('preferFusion=false uses classic /swap', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('/quote')) return json({ dstAmount: '995000' })
      if (url.includes('/swap')) return json({ txHash: '0xswap' })
      return json({ error: 'unexpected' }, 500)
    })
    const client = createOneInchClient({ baseUrl: 'https://api', fetchImpl, preferFusion: false })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.txHash).toBe('0xswap')
  })

  it('a non-ok /quote surfaces as quote-failed (merchant keeps settled USDC)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: 'rate limited' }, 429))
    const client = createOneInchClient({ baseUrl: 'https://api', fetchImpl })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('quote-failed')
  })

  it('a quote below the slippage floor is rejected as slippage-exceeded', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('/quote')) return json({ dstAmount: '980000' }) // below 990000 floor
      return json({ txHash: '0xnope' })
    })
    const client = createOneInchClient({ baseUrl: 'https://api', fetchImpl })
    const res = await runPayoutSwap(baseReq(), client)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('slippage-exceeded')
  })
})
