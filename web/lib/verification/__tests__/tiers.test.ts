/**
 * @file tiers.test.ts — the Super Verification tier logic (pure, offline).
 *
 * Pins the spec rules: Standard (0) -> Verified (>=1) -> Super Verified
 * (World ID + >=2 others, OR >=3 methods). World ID is the strongest single
 * rung. Score is the clamped sum of method weights.
 */
import { describe, expect, it } from 'vitest'
import {
  LEVEL_LABELS,
  METHOD_WEIGHTS,
  asTrustTier,
  asVerificationMethod,
  computeTier,
  computeTrustScore,
  hasWorldId,
  levelFor,
  levelToTier,
  nextStepToSuper,
  normalizeMethods,
  tierMeets,
  tierToLevel,
  type VerificationMethod,
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

// ── The 5-rung LEVEL ladder (verification-levels ADR) ───────────────────────
const m = (...methods: VerificationMethod[]): VerificationMethod[] => methods

describe('levelFor — the 5-rung ladder, each rung from a representative set', () => {
  it('L0 Guest — no methods, score 0', () => {
    const r = levelFor(m())
    expect(r.level).toBe(0)
    expect(r.name).toBe('Guest')
    expect(r.nextNeed).toMatch(/World ID/) // points at the strongest next add
  })

  it('L1 Connected — a lone sign-in (Dynamic) -> "someone", score 15', () => {
    const r = levelFor(m('dynamic'))
    expect(r.level).toBe(1)
    expect(r.name).toBe('Connected')
  })

  it('L1 Connected — a lone on-chain signal (score 10)', () => {
    expect(levelFor(m('onchain')).level).toBe(1)
  })

  it('L1 Connected — a lone OIDC sign-in (score 15)', () => {
    expect(levelFor(m('oidc')).level).toBe(1)
  })

  it('L2 Verified — World ID alone (one strong proof)', () => {
    const r = levelFor(m('world-id'))
    expect(r.level).toBe(2)
    expect(r.name).toBe('Verified')
  })

  it('L2 Verified — ENS + a sign-in (score 40), no World ID', () => {
    expect(levelFor(m('ens', 'dynamic')).level).toBe(2)
    expect(levelFor(m('ens', 'oidc')).level).toBe(2)
  })

  it('L2 Verified — ENS alone reaches the score>=25 bar', () => {
    expect(levelFor(m('ens')).level).toBe(2)
  })

  it('L3 Trusted — World ID + exactly one more (structural rung wins over score 75)', () => {
    const r = levelFor(m('world-id', 'ens')) // 50 + 25 = 75
    expect(r.level).toBe(3)
    expect(r.name).toBe('Trusted')
  })

  it('L3 Trusted — World ID + a sign-in', () => {
    expect(levelFor(m('world-id', 'dynamic')).level).toBe(3)
  })

  it('L4 Super Verified — World ID + two others', () => {
    const r = levelFor(m('world-id', 'ens', 'dynamic'))
    expect(r.level).toBe(4)
    expect(r.name).toBe('Super Verified')
    expect(r.nextNeed).toBe('') // nothing more to ask for
  })

  it('L4 Super Verified — all four methods', () => {
    expect(levelFor(m('world-id', 'ens', 'dynamic', 'onchain')).level).toBe(4)
  })

  it('L4 Super Verified — score>=75 without World ID (deep non-WID composite)', () => {
    // ens(25)+dynamic(15)+oidc(15)+onchain(10) = 65 < 75 -> NOT L4 by score; but
    // methods.length >= 4 also promotes a deep stack. Force the score path with
    // an explicit precomputed score >= 75.
    const r = levelFor(80, m('ens', 'dynamic', 'onchain'))
    expect(r.level).toBe(4)
  })

  it('a 3-method NON-World-ID stack is L2 on the ladder (stricter than legacy super)', () => {
    // The level ladder requires World ID OR score>=75 for Super; ens+dynamic+
    // onchain = 50 maps to L2 here even though legacy computeTier calls it super.
    expect(levelFor(m('ens', 'dynamic', 'onchain')).level).toBe(2)
    expect(computeTier(p('ens', 'dynamic', 'onchain'))).toBe('super-verified') // legacy unchanged
  })

  it('accepts (score, methods) and (methods) call shapes equivalently', () => {
    expect(levelFor(computeTrustScore(p('world-id', 'ens')), m('world-id', 'ens')).level).toBe(3)
    expect(levelFor(m('world-id', 'ens')).level).toBe(3)
  })

  it('dedupes — duplicate methods do not inflate the level', () => {
    expect(levelFor(['ens', 'ens', 'ens'] as never).level).toBe(2)
    expect(levelFor(m('world-id', 'world-id' as VerificationMethod, 'ens')).level).toBe(3)
  })

  it('every level has a label', () => {
    expect(Object.values(LEVEL_LABELS)).toEqual([
      'Guest',
      'Connected',
      'Verified',
      'Trusted',
      'Super Verified',
    ])
  })
})

describe('tierToLevel / levelToTier — legacy<->ladder mapping (gate preserved)', () => {
  it('tierToLevel maps the 3 legacy tiers onto the ladder', () => {
    expect(tierToLevel('standard')).toBe(1)
    expect(tierToLevel('verified')).toBe(2)
    expect(tierToLevel('super-verified')).toBe(4)
  })
  it('levelToTier maps the ladder back for the merchant gate', () => {
    expect(levelToTier(0)).toBe('standard')
    expect(levelToTier(1)).toBe('standard')
    expect(levelToTier(2)).toBe('verified')
    expect(levelToTier(3)).toBe('verified')
    expect(levelToTier(4)).toBe('super-verified')
  })
})
