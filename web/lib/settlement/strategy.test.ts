/**
 * strategy.test.ts — the settlement seam must default to `direct`, honor a
 * registered+selected strategy, and NEVER drop settlement on an unknown id (it
 * falls back to direct). Pure logic, no network.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  configuredStrategyId,
  directStrategy,
  isBatchedSettlementActive,
  registerSettlementStrategy,
  resolveSettlementStrategy,
  type SettlementStrategy,
} from './strategy'

const ENV = 'NEXT_PUBLIC_SETTLEMENT_STRATEGY'

afterEach(() => {
  delete process.env[ENV]
})

describe('settlement strategy seam', () => {
  it('defaults to direct when unset', () => {
    expect(configuredStrategyId()).toBe('direct')
    expect(resolveSettlementStrategy().id).toBe('direct')
    expect(isBatchedSettlementActive()).toBe(false)
  })

  it('direct.plan returns a single-charge plan', () => {
    const charge = { merchantId: 1n, usdAmount8: 100n, orderId: '0xabc' as `0x${string}` }
    expect(directStrategy.plan(charge)).toEqual({ mode: 'direct', charges: [charge] })
  })

  it('resolves a registered strategy once selected', () => {
    const batched: SettlementStrategy = {
      id: 'batched-test',
      plan: (c) => ({ mode: 'batched', charges: [c] }),
    }
    registerSettlementStrategy(batched)
    process.env[ENV] = 'batched-test'
    expect(resolveSettlementStrategy().id).toBe('batched-test')
    expect(isBatchedSettlementActive()).toBe(true)
  })

  it('falls back to direct for an unknown id (never drops settlement)', () => {
    process.env[ENV] = 'does-not-exist'
    expect(resolveSettlementStrategy().id).toBe('direct')
  })
})
