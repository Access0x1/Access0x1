/**
 * @file worker.test.ts — happy-path + branch unit tests for runPayoutSwap.
 *
 * Offline only: the rail is a mock {@link PayoutSwapClient}, so the worker's branching,
 * slippage enforcement, and result shaping are pinned with zero network. Covers:
 *  - USDC-default no-op (the universal floor),
 *  - the correct rail per chain (Base / Arc / zkSync),
 *  - quote → slippage floor → execute ordering on success.
 */
import { describe, expect, it, vi } from 'vitest'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'

import { arcTestnet } from '../../chains.js'
import { runPayoutSwap } from '../worker.js'
import type {
  PayoutSwapClient,
  RailQuote,
  SwapRail,
  SwapRequest,
} from '../types.js'

const USDC = '0x1111111111111111111111111111111111111111' as const
const PAYOUT = '0x2222222222222222222222222222222222222222' as const
const MERCHANT = '0x3333333333333333333333333333333333333333' as const

function mockClient(rail: SwapRail, amountOut: bigint, txHash = '0xfeed'): PayoutSwapClient {
  return {
    rail,
    quote: vi.fn(async (): Promise<RailQuote> => ({ amountOut })),
    execute: vi.fn(async () => ({ txHash, rail })),
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

describe('runPayoutSwap — happy paths', () => {
  it('USDC default (payoutToken === usdc) is a no-op — never calls the rail', async () => {
    const client = mockClient('uniswap-trading-api', 1n)
    const res = await runPayoutSwap(req({ payoutToken: USDC }), client)
    expect(res.swapped).toBe(false)
    expect(res.reason).toBe('usdc-default-no-op')
    expect(client.quote).not.toHaveBeenCalled()
    expect(client.execute).not.toHaveBeenCalled()
  })

  it('USDC default is case-insensitive (checksum mismatch still detected)', async () => {
    const client = mockClient('uniswap-trading-api', 1n)
    const lower = USDC.toLowerCase() as `0x${string}`
    const upper = USDC.toUpperCase().replace('0X', '0x') as `0x${string}`
    const res = await runPayoutSwap(req({ usdc: lower, payoutToken: upper }), client)
    expect(res.reason).toBe('usdc-default-no-op')
  })

  it('Base → uniswap-trading-api: quote, floor met, executes', async () => {
    const client = mockClient('uniswap-trading-api', 995_000n, '0xbase')
    const res = await runPayoutSwap(req({ chainId: baseSepolia.id }), client)
    expect(res.swapped).toBe(true)
    expect(res.rail).toBe('uniswap-trading-api')
    expect(res.txHash).toBe('0xbase')
    expect(res.amountOut).toBe(995_000n)
    expect(client.quote).toHaveBeenCalledOnce()
    expect(client.execute).toHaveBeenCalledOnce()
  })

  it('Arc → circle-app-kit executes (Arc ranks above Uniswap; default chain)', async () => {
    const client = mockClient('circle-app-kit', 995_000n, '0xarc')
    const res = await runPayoutSwap(req({ chainId: arcTestnet.id }), client)
    expect(res.swapped).toBe(true)
    expect(res.rail).toBe('circle-app-kit')
    expect(res.txHash).toBe('0xarc')
  })

  it('zkSync → uniswap-classic executes', async () => {
    const client = mockClient('uniswap-classic', 995_000n, '0xzk')
    const res = await runPayoutSwap(req({ chainId: zksyncSepoliaTestnet.id }), client)
    expect(res.swapped).toBe(true)
    expect(res.rail).toBe('uniswap-classic')
  })

  it('quote runs BEFORE execute (floor enforced pre-state-change)', async () => {
    const order: string[] = []
    const client: PayoutSwapClient = {
      rail: 'uniswap-trading-api',
      quote: vi.fn(async () => {
        order.push('quote')
        return { amountOut: 1_000_000n }
      }),
      execute: vi.fn(async () => {
        order.push('execute')
        return { txHash: '0x', rail: 'uniswap-trading-api' as const }
      }),
    }
    await runPayoutSwap(req(), client)
    expect(order).toEqual(['quote', 'execute'])
  })
})
