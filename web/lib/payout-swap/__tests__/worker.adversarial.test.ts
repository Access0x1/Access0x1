/**
 * @file worker.adversarial.test.ts — failure-isolation + invariant edges for runPayoutSwap.
 *
 * Pins law #5 ("money paths never swallow; a failed swap is purely additive"):
 *  - a slippage-floor breach NEVER executes,
 *  - a failed / rejecting quote or execute NEVER throws and NEVER blocks settlement
 *    (the merchant keeps settled USDC),
 *  - a wrong / uncapable chain is rejected (no rail invented),
 *  - a rail-mismatch (client's rail ≠ the chain's required rail) is rejected before any call,
 *  - a non-positive amount is rejected,
 *  - the worker can NEVER reject — every adversarial input resolves to a result.
 */
import { describe, expect, it, vi } from 'vitest'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'

import { arcTestnet } from '../../chains.js'
import { runPayoutSwap } from '../worker.js'
import type { PayoutSwapClient, RailQuote, SwapRail, SwapRequest } from '../types.js'

const USDC = '0x1111111111111111111111111111111111111111' as const
const PAYOUT = '0x2222222222222222222222222222222222222222' as const
const MERCHANT = '0x3333333333333333333333333333333333333333' as const

function client(
  rail: SwapRail,
  opts: {
    quote?: () => Promise<RailQuote>
    execute?: () => Promise<{ txHash: string; rail: SwapRail }>
  } = {},
): PayoutSwapClient {
  return {
    rail,
    quote: vi.fn(opts.quote ?? (async () => ({ amountOut: 1_000_000n }))),
    execute: vi.fn(opts.execute ?? (async () => ({ txHash: '0x', rail }))),
  }
}

function req(over: Partial<SwapRequest> = {}): SwapRequest {
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

describe('runPayoutSwap — adversarial / law #5', () => {
  it('slippage bound RESPECTED: quote below minAmountOut never executes', async () => {
    const c = client('uniswap-trading-api', { quote: async () => ({ amountOut: 989_999n }) })
    const res = await runPayoutSwap(req({ minAmountOut: 990_000n }), c)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('slippage-exceeded')
    expect(c.execute).not.toHaveBeenCalled()
  })

  it('slippage floor is inclusive: amountOut === minAmountOut executes', async () => {
    const c = client('uniswap-trading-api', { quote: async () => ({ amountOut: 990_000n }) })
    const res = await runPayoutSwap(req({ minAmountOut: 990_000n }), c)
    expect(res.swapped).toBe(true)
  })

  it('FAILED quote never throws and never blocks — merchant keeps settled USDC', async () => {
    const c = client('uniswap-trading-api', {
      quote: async () => {
        throw new Error('Trading API 503')
      },
    })
    const res = await runPayoutSwap(req(), c)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('quote-failed')
    expect(res.detail).toContain('503')
    expect(c.execute).not.toHaveBeenCalled()
  })

  it('FAILED / EXPIRED execute never throws and never blocks (USDC stays with merchant)', async () => {
    const c = client('uniswap-trading-api', {
      execute: async () => {
        throw new Error('order expired')
      },
    })
    const res = await runPayoutSwap(req(), c)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('execute-failed')
    expect(res.detail).toContain('expired')
  })

  it('WRONG / uncapable chain rejected — no rail invented', async () => {
    const c = client('uniswap-trading-api')
    const res = await runPayoutSwap(req({ chainId: 1 /* ethereum mainnet: no rail here */ }), c)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('chain-not-capable')
    expect(c.quote).not.toHaveBeenCalled()
  })

  it('RAIL MISMATCH rejected before any call (Base requires trading-api, client drives classic)', async () => {
    const wrong = client('uniswap-classic') // mismatched against baseSepolia's required rail
    const res = await runPayoutSwap(req({ chainId: baseSepolia.id }), wrong)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('rail-mismatch')
    expect(wrong.quote).not.toHaveBeenCalled()
  })

  it('zkSync mismatch: a circle-app-kit client on zkSync is rejected (App Kit absent on zkSync)', async () => {
    const wrong = client('circle-app-kit')
    const res = await runPayoutSwap(req({ chainId: zksyncSepoliaTestnet.id }), wrong)
    expect(res.reason).toBe('rail-mismatch')
  })

  it('Arc mismatch: a uniswap client on Arc is rejected (Uniswap has nothing on Arc)', async () => {
    const wrong = client('uniswap-trading-api')
    const res = await runPayoutSwap(req({ chainId: arcTestnet.id, payoutToken: PAYOUT }), wrong)
    expect(res.reason).toBe('rail-mismatch')
  })

  it('non-positive amount rejected (zero)', async () => {
    const c = client('uniswap-trading-api')
    const res = await runPayoutSwap(req({ amountUsdc: 0n }), c)
    expect(res.reason).toBe('invalid-request')
    expect(c.quote).not.toHaveBeenCalled()
  })

  it('negative amount rejected', async () => {
    const c = client('uniswap-trading-api')
    const res = await runPayoutSwap(req({ amountUsdc: -5n }), c)
    expect(res.reason).toBe('invalid-request')
  })

  it('negative minAmountOut rejected (malformed floor)', async () => {
    const c = client('uniswap-trading-api')
    const res = await runPayoutSwap(req({ minAmountOut: -1n }), c)
    expect(res.reason).toBe('invalid-request')
    expect(c.quote).not.toHaveBeenCalled()
  })

  it('a non-Error thrown value is still isolated (no leak, never rejects)', async () => {
    const c = client('uniswap-trading-api', {
      quote: async () => {
        throw 'string failure' // eslint-disable-line no-throw-literal
      },
    })
    const res = await runPayoutSwap(req(), c)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('quote-failed')
    expect(res.detail).toBe('string failure')
  })

  it('the worker never rejects — even with a totally hostile client (both legs throw)', async () => {
    const hostile: PayoutSwapClient = {
      rail: 'uniswap-trading-api',
      quote: async () => {
        throw new Error('boom')
      },
      execute: async () => {
        throw new Error('boom')
      },
    }
    await expect(runPayoutSwap(req(), hostile)).resolves.toMatchObject({ swapped: false })
  })
})
