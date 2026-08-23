/**
 * ownName.test.ts — the step engine: order, timing window, persistence, owner binding.
 *
 * The protocol's ordering rules are enforced HERE so the UI can't offer a
 * transaction that is guaranteed to revert on-chain.
 */
import { describe, expect, it } from 'vitest'

import {
  canRegisterFrom,
  clearPending,
  commitmentPhase,
  currentStep,
  loadPending,
  pendingKey,
  savePending,
  secondsUntilOpen,
  type PendingCommitment,
  type PendingStore,
} from '../ownName'

const OWNER = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const T0 = 1_700_000_000_000

function memStore(): PendingStore {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

function pending(overrides: Partial<PendingCommitment> = {}): PendingCommitment {
  return {
    label: 'acme',
    owner: OWNER,
    durationSeconds: '31557600',
    secret: `0x${'ab'.repeat(32)}` as `0x${string}`,
    resolver: '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD',
    data: [],
    reverseRecord: true,
    commitment: `0x${'cd'.repeat(32)}` as `0x${string}`,
    chainId: 11155111,
    controller: '0x253553366Da8546fC250F225fe3d25d0C782303b',
    committedAtMs: T0,
    minAgeS: 60,
    maxAgeS: 86_400,
    ...overrides,
  }
}

describe('commitmentPhase (the single timing authority)', () => {
  it('waits through minAge PLUS the safety margin — no early register offer', () => {
    const p = pending()
    expect(commitmentPhase(p, T0 + 59_000)).toBe('waiting')
    expect(commitmentPhase(p, T0 + 60_000)).toBe('waiting') // exactly 60s: still unsafe
    expect(commitmentPhase(p, T0 + 73_000)).toBe('open') // 60s + 12s margin passed
  })

  it('expires before the on-chain 24h wall (margin on the far edge too)', () => {
    const p = pending()
    expect(commitmentPhase(p, T0 + 86_387_000)).toBe('open')
    expect(commitmentPhase(p, T0 + 86_400_000)).toBe('expired')
  })

  it('falls back to deployed 60s/24h when the stored window is corrupt', () => {
    const p = pending({ minAgeS: 0, maxAgeS: -5 })
    expect(commitmentPhase(p, T0 + 10_000)).toBe('waiting')
    expect(commitmentPhase(p, T0 + 73_000)).toBe('open')
  })

  it('secondsUntilOpen drives the countdown and floors at 0', () => {
    const p = pending()
    expect(secondsUntilOpen(p, T0)).toBe(72)
    expect(secondsUntilOpen(p, T0 + 73_000)).toBe(0)
  })
})

describe('persistence (a refresh never strands a paid commit tx)', () => {
  it('round-trips a pending commitment per (chain, wallet)', () => {
    const store = memStore()
    savePending(store, pending())
    const back = loadPending(store, 11155111, OWNER, T0 + 70_000)
    expect(back?.label).toBe('acme')
    expect(back?.secret).toBe(`0x${'ab'.repeat(32)}`)
  })

  it('drops an EXPIRED pending instead of returning a doomed one', () => {
    const store = memStore()
    savePending(store, pending())
    expect(loadPending(store, 11155111, OWNER, T0 + 87_000_000)).toBeNull()
    expect(store.getItem(pendingKey(11155111, OWNER))).toBeNull()
  })

  it('drops garbage instead of throwing', () => {
    const store = memStore()
    store.setItem(pendingKey(11155111, OWNER), '{not json')
    expect(loadPending(store, 11155111, OWNER, T0)).toBeNull()
  })

  it('clearPending forgets after registration', () => {
    const store = memStore()
    savePending(store, pending())
    clearPending(store, 11155111, OWNER)
    expect(loadPending(store, 11155111, OWNER, T0)).toBeNull()
  })
})

describe('owner binding (the committed owner is baked into the hash)', () => {
  it('only the committed wallet may register', () => {
    const p = pending()
    expect(canRegisterFrom(p, OWNER)).toBe(true)
    expect(canRegisterFrom(p, OWNER.toUpperCase() as typeof OWNER)).toBe(true) // case-insensitive
    expect(canRegisterFrom(p, OTHER)).toBe(false)
    expect(canRegisterFrom(p, undefined)).toBe(false)
  })
})

describe('currentStep (the one place step order is decided)', () => {
  it('a wallet that already HAS a primary name skips the whole flow', () => {
    expect(currentStep({ hasPrimaryName: true, pending: null, nowMs: T0 })).toBe('already_named')
  })

  it('walks the exact protocol order', () => {
    const p = pending()
    expect(currentStep({ hasPrimaryName: false, pending: null, nowMs: T0 })).toBe('pick')
    expect(currentStep({ hasPrimaryName: false, pending: null, nowMs: T0, txInFlight: 'commit' })).toBe('committing')
    expect(currentStep({ hasPrimaryName: false, pending: p, nowMs: T0 + 30_000 })).toBe('waiting')
    expect(currentStep({ hasPrimaryName: false, pending: p, nowMs: T0 + 80_000 })).toBe('ready_to_register')
    expect(currentStep({ hasPrimaryName: false, pending: p, nowMs: T0 + 80_000, txInFlight: 'register' })).toBe('registering')
    expect(currentStep({ hasPrimaryName: false, pending: p, nowMs: T0 + 80_000, registered: true })).toBe('done')
  })

  it('an expired commitment demands a fresh commit — never a doomed register', () => {
    const p = pending()
    expect(currentStep({ hasPrimaryName: false, pending: p, nowMs: T0 + 90_000_000 })).toBe('expired')
  })
})
