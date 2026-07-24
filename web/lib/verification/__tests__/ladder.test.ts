/**
 * @file ladder.test.ts — the 3-rung ladder mapping + the one-button chooser.
 *
 * Proves the simple surface's two pure decisions:
 *   - rungFor: which of ○ / ✓ / ✓✓ a method set earns (strong proofs = ENS or
 *     World ID; ✓✓ needs both plus a sign-in).
 *   - nextLadderAction: EXACTLY ONE next step per state — never a menu — with
 *     the one-tap option preferred and fail-soft rerouting when World ID is off.
 */
import { describe, expect, it } from 'vitest'

import { nextLadderAction, rungFor, RUNG_INFO, LADDER_RUNGS } from '../ladder'
import type { VerificationMethod } from '../tiers'

const m = (...methods: VerificationMethod[]): VerificationMethod[] => methods

describe('rungFor — the three rungs', () => {
  it('○ Connected: no methods', () => {
    expect(rungFor([])).toBe(0)
  })

  it('○ Connected: weak signals alone never earn ✓', () => {
    expect(rungFor(m('dynamic'))).toBe(0)
    expect(rungFor(m('onchain'))).toBe(0)
    expect(rungFor(m('dynamic', 'oidc', 'onchain'))).toBe(0)
  })

  it('✓ Verified: either strong proof alone', () => {
    expect(rungFor(m('ens'))).toBe(1)
    expect(rungFor(m('world-id'))).toBe(1)
  })

  it('✓ Verified: both strong proofs but NO sign-in stays ✓', () => {
    expect(rungFor(m('ens', 'world-id'))).toBe(1)
    expect(rungFor(m('ens', 'world-id', 'onchain'))).toBe(1)
  })

  it('✓✓ Super: both strong proofs + a sign-in (either kind)', () => {
    expect(rungFor(m('ens', 'world-id', 'dynamic'))).toBe(2)
    expect(rungFor(m('ens', 'world-id', 'oidc'))).toBe(2)
  })
})

describe('nextLadderAction — exactly one button', () => {
  it('nothing yet + recognized ENS name → the one-tap ENS verify', () => {
    expect(nextLadderAction([], { hasRecognizedEnsName: true })?.method).toBe('ens')
  })

  it('nothing yet, no recognized name → World ID (one tap)', () => {
    expect(nextLadderAction([])?.method).toBe('world-id')
  })

  it('nothing yet, World ID off → ENS (typed name) instead of a dead end', () => {
    expect(nextLadderAction([], { worldIdUnavailable: true })?.method).toBe('ens')
  })

  it('✓ via World ID → the missing strong proof is ENS', () => {
    expect(nextLadderAction(m('world-id'))?.method).toBe('ens')
  })

  it('✓ via ENS → the missing strong proof is World ID', () => {
    expect(nextLadderAction(m('ens'))?.method).toBe('world-id')
  })

  it('✓ via ENS with World ID off → the sign-in still moves things forward', () => {
    expect(nextLadderAction(m('ens'), { worldIdUnavailable: true })?.method).toBe('dynamic')
  })

  it('✓ via ENS, World ID off, sign-in already done → null (never a fake step)', () => {
    expect(nextLadderAction(m('ens', 'dynamic'), { worldIdUnavailable: true })).toBeNull()
  })

  it('both strong proofs, no sign-in → confirm the sign-in', () => {
    expect(nextLadderAction(m('ens', 'world-id'))?.method).toBe('dynamic')
  })

  it('✓✓ → null (nothing left to offer)', () => {
    expect(nextLadderAction(m('ens', 'world-id', 'dynamic'))).toBeNull()
  })

  it('every offered action carries button copy (label + hint)', () => {
    for (const methods of [[], m('ens'), m('world-id'), m('ens', 'world-id')]) {
      const action = nextLadderAction(methods)
      expect(action).not.toBeNull()
      expect(action!.label.length).toBeGreaterThan(0)
      expect(action!.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('rung display metadata', () => {
  it('the chip row renders ○ → ✓ → ✓✓ in climb order', () => {
    expect(LADDER_RUNGS.map((r) => RUNG_INFO[r].symbol)).toEqual(['○', '✓', '✓✓'])
    expect(RUNG_INFO[2].label).toBe('Super Verified')
  })
})
