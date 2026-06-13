/**
 * @file tiers.test.ts — the Super Verification tier logic (pure, offline).
 *
 * Pins the spec rules: Standard (0) -> Verified (>=1) -> Super Verified
 * (World ID + >=2 others, OR >=3 methods). World ID is the strongest single
 * rung. Score is the clamped sum of method weights.
 */
import { describe, expect, it } from 'vitest'
import {
  METHOD_WEIGHTS,
  asTrustTier,
  asVerificationMethod,
  computeTier,
  computeTrustScore,
  hasWorldId,
  nextStepToSuper,
  normalizeMethods,
  tierMeets,
  type VerificationProfile,
} from '../tiers'

const p = (...methods: VerificationProfile['methods']): VerificationProfile => ({ methods })

describe('computeTier', () => {
  it('0 methods -> standard', () => {
    expect(computeTier(p())).toBe('standard')
  })

  it('1 method (non-World-ID) -> verified', () => {
    expect(computeTier(p('ens'))).toBe('verified')
    expect(computeTier(p('dynamic'))).toBe('verified')
    expect(computeTier(p('onchain'))).toBe('verified')
  })

  it('World ID alone -> verified (strongest single rung, not yet super)', () => {
    expect(computeTier(p('world-id'))).toBe('verified')
  })

  it('World ID + 1 other -> verified (needs 2 others for super)', () => {
    expect(computeTier(p('world-id', 'ens'))).toBe('verified')
  })

  it('World ID + 2 others -> super-verified', () => {
    expect(computeTier(p('world-id', 'ens', 'dynamic'))).toBe('super-verified')
  })

  it('3 methods WITHOUT World ID -> super-verified (composite)', () => {
    expect(computeTier(p('ens', 'dynamic', 'onchain'))).toBe('super-verified')
  })

  it('all 4 methods -> super-verified', () => {
    expect(computeTier(p('world-id', 'ens', 'dynamic', 'onchain'))).toBe('super-verified')
  })

  it('dupes do not inflate the tier', () => {
    expect(computeTier(p('ens', 'ens', 'ens'))).toBe('verified')
  })
})

describe('computeTrustScore', () => {
  it('sums method weights', () => {
    expect(computeTrustScore(p('world-id'))).toBe(METHOD_WEIGHTS['world-id'])
    expect(computeTrustScore(p('ens', 'dynamic'))).toBe(
      METHOD_WEIGHTS.ens + METHOD_WEIGHTS.dynamic,
    )
  })
  it('clamps to 100', () => {
    expect(computeTrustScore(p('world-id', 'ens', 'dynamic', 'onchain'))).toBe(100)
  })
  it('empty -> 0', () => {
    expect(computeTrustScore(p())).toBe(0)
  })
  it('dupes do not double-count', () => {
    expect(computeTrustScore(p('ens', 'ens'))).toBe(METHOD_WEIGHTS.ens)
  })
})

describe('hasWorldId / normalizeMethods', () => {
  it('hasWorldId reflects the anchor method', () => {
    expect(hasWorldId(p('world-id', 'ens'))).toBe(true)
    expect(hasWorldId(p('ens'))).toBe(false)
  })
  it('normalizeMethods dedupes, drops unknowns, keeps priority order', () => {
    expect(normalizeMethods(['ens', 'world-id', 'ens'] as never)).toEqual(['world-id', 'ens'])
    expect(normalizeMethods(['bogus', 'dynamic'] as never)).toEqual(['dynamic'])
  })
})

describe('tierMeets — the merchant gate predicate', () => {
  it('super-verified meets every requirement', () => {
    expect(tierMeets('super-verified', 'standard')).toBe(true)
    expect(tierMeets('super-verified', 'verified')).toBe(true)
    expect(tierMeets('super-verified', 'super-verified')).toBe(true)
  })
  it('verified does NOT meet super-verified', () => {
    expect(tierMeets('verified', 'super-verified')).toBe(false)
    expect(tierMeets('verified', 'verified')).toBe(true)
  })
  it('standard meets only standard', () => {
    expect(tierMeets('standard', 'verified')).toBe(false)
    expect(tierMeets('standard', 'standard')).toBe(true)
  })
})

describe('asTrustTier / asVerificationMethod narrowers', () => {
  it('asTrustTier narrows or defaults to standard', () => {
    expect(asTrustTier('super-verified')).toBe('super-verified')
    expect(asTrustTier('garbage')).toBe('standard')
  })
  it('asVerificationMethod narrows or returns null', () => {
    expect(asVerificationMethod('world-id')).toBe('world-id')
    expect(asVerificationMethod('nope')).toBeNull()
  })
})

describe('oidc method (Sign in with Google) stacks like the others', () => {
  it('is a recognized method with a weight', () => {
    expect(asVerificationMethod('oidc')).toBe('oidc')
    expect(METHOD_WEIGHTS.oidc).toBeGreaterThan(0)
  })
  it('oidc alone -> verified', () => {
    expect(computeTier(p('oidc'))).toBe('verified')
    expect(computeTrustScore(p('oidc'))).toBe(METHOD_WEIGHTS.oidc)
  })
  it('World ID + ens + oidc -> super-verified (oidc counts as an "other")', () => {
    expect(computeTier(p('world-id', 'ens', 'oidc'))).toBe('super-verified')
  })
  it('oidc + ens + onchain (no World ID) -> super-verified (3-method composite)', () => {
    expect(computeTier(p('oidc', 'ens', 'onchain'))).toBe('super-verified')
  })
  it('normalizeMethods keeps oidc in priority order (after dynamic, before onchain)', () => {
    expect(normalizeMethods(['onchain', 'oidc', 'world-id'] as never)).toEqual([
      'world-id',
      'oidc',
      'onchain',
    ])
  })
})

describe('nextStepToSuper', () => {
  it('null once super-verified', () => {
    expect(nextStepToSuper(p('ens', 'dynamic', 'onchain'))).toBeNull()
  })
  it('nudges World ID first when absent', () => {
    expect(nextStepToSuper(p('ens'))).toMatch(/World ID/)
  })
  it('asks for more others when World ID present', () => {
    expect(nextStepToSuper(p('world-id'))).toMatch(/more/)
  })
})
