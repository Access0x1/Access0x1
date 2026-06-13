/**
 * @file capabilities.test.ts — the per-chain swap capability flag + client selection.
 *
 * Pins the rail-per-chain mapping (Arc → App Kit, Base → Trading API, zkSync → classic),
 * the fail-safe for unknown chains, and that selectPayoutSwapClient throws loudly on a
 * missing dependency for a capable chain (a wiring bug) but returns null for an uncapable one.
 */
import { describe, expect, it, vi } from 'vitest'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'

import { arcTestnet } from '../../chains.js'
import { getSwapCapability, isSwapCapable } from '../capabilities.js'
import { selectPayoutSwapClient, type PayoutSwapDeps } from '../index.js'

describe('getSwapCapability — rail per chain', () => {
  it('Arc → circle-app-kit', () => {
    expect(getSwapCapability(arcTestnet.id)).toEqual({
      chainId: arcTestnet.id,
      canSwap: true,
      rail: 'circle-app-kit',
    })
  })
  it('Base → uniswap-trading-api', () => {
    expect(getSwapCapability(baseSepolia.id).rail).toBe('uniswap-trading-api')
  })
  it('zkSync → uniswap-classic', () => {
    expect(getSwapCapability(zksyncSepoliaTestnet.id).rail).toBe('uniswap-classic')
  })
  it('unknown chain → not capable (fail safe, no rail)', () => {
    const cap = getSwapCapability(999999)
    expect(cap.canSwap).toBe(false)
    expect(cap.rail).toBeUndefined()
  })
  it('isSwapCapable matches', () => {
    expect(isSwapCapable(baseSepolia.id)).toBe(true)
    expect(isSwapCapable(1)).toBe(false)
  })
})

const deps: PayoutSwapDeps = {
  uniswapTradingApi: { baseUrl: 'https://x', fetchImpl: vi.fn() },
  uniswapClassic: {
    baseUrl: 'https://x',
    fetchImpl: vi.fn(),
    submitDirect: vi.fn(async () => '0x'),
  },
  circleAppKit: { getSwapQuote: vi.fn(), executeSwap: vi.fn() },
}

describe('selectPayoutSwapClient', () => {
  it('picks the trading-api client for Base', () => {
    expect(selectPayoutSwapClient(baseSepolia.id, deps)?.rail).toBe('uniswap-trading-api')
  })
  it('picks the classic client for zkSync', () => {
    expect(selectPayoutSwapClient(zksyncSepoliaTestnet.id, deps)?.rail).toBe('uniswap-classic')
  })
  it('picks the app-kit client for Arc', () => {
    expect(selectPayoutSwapClient(arcTestnet.id, deps)?.rail).toBe('circle-app-kit')
  })
  it('returns null for an uncapable chain (worker then no-ops)', () => {
    expect(selectPayoutSwapClient(1, deps)).toBeNull()
  })
  it('throws loudly when a capable chain is missing its dependency (wiring bug)', () => {
    expect(() => selectPayoutSwapClient(baseSepolia.id, {})).toThrow(/uniswap-trading-api/)
    expect(() => selectPayoutSwapClient(arcTestnet.id, {})).toThrow(/circle-app-kit/)
    expect(() => selectPayoutSwapClient(zksyncSepoliaTestnet.id, {})).toThrow(/uniswap-classic/)
  })
})
