/**
 * agentGate.test.ts — the Track-A human-backed agent trial gate (World ID ADR
 * D6 / unit 7) + the nullifier-store dedup primitive (unit 1).
 *
 * Pins:
 *   - the gate is OFF by default (AGENT_REQUIRE_HUMAN unset) → no-op, existing
 *     agent behavior preserved,
 *   - when required, an unverified agent throws HumanGateRequired,
 *   - unlocking (a verified-human agent proof) then allows the trial,
 *   - the nullifier store enforces UNIQUE(action, nullifier) and normalizes
 *     hex/decimal to one identity.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HumanGateRequired,
  __resetAgentTrialForTests,
  assertAgentTrialAllowed,
  isAgentTrialUnlocked,
  unlockAgentTrial,
} from '../agentGate.js'
import {
  __resetNullifierStore,
  claimNullifier,
  hasNullifier,
  normalizeNullifier,
} from '../nullifierStore.js'

const ORIGINAL_ENV = process.env.AGENT_REQUIRE_HUMAN

beforeEach(() => {
  __resetAgentTrialForTests()
  __resetNullifierStore()
})
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.AGENT_REQUIRE_HUMAN
  else process.env.AGENT_REQUIRE_HUMAN = ORIGINAL_ENV
})

describe('agent trial gate', () => {
  it('is a no-op when AGENT_REQUIRE_HUMAN is unset (fail-soft default)', () => {
    delete process.env.AGENT_REQUIRE_HUMAN
    expect(() => assertAgentTrialAllowed()).not.toThrow()
  })

  it('throws HumanGateRequired for an unverified agent when required', () => {
    process.env.AGENT_REQUIRE_HUMAN = 'true'
    expect(isAgentTrialUnlocked()).toBe(false)
    expect(() => assertAgentTrialAllowed()).toThrow(HumanGateRequired)
  })

  it('allows the trial once the agent is verified-human-backed', () => {
    process.env.AGENT_REQUIRE_HUMAN = 'true'
    unlockAgentTrial()
    expect(isAgentTrialUnlocked()).toBe(true)
    expect(() => assertAgentTrialAllowed()).not.toThrow()
  })
})

describe('nullifier store — UNIQUE(action, nullifier)', () => {
  it('claims a fresh nullifier then rejects the repeat', () => {
    expect(claimNullifier('act', '0x10')).toBe(true)
    expect(claimNullifier('act', '0x10')).toBe(false)
    expect(hasNullifier('act', '0x10')).toBe(true)
  })

  it('scopes by action — same nullifier on a different action is fresh', () => {
    expect(claimNullifier('act-a', '0x10')).toBe(true)
    expect(claimNullifier('act-b', '0x10')).toBe(true)
  })

  it('normalizes hex and decimal to the same identity', () => {
    expect(normalizeNullifier('0xff')).toBe('255')
    expect(claimNullifier('act', '0xff')).toBe(true)
    expect(claimNullifier('act', '255')).toBe(false) // same human
  })

  it('throws on a malformed nullifier', () => {
    expect(() => normalizeNullifier('not-a-number')).toThrow()
    expect(() => normalizeNullifier('')).toThrow()
  })
})
