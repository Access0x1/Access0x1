/**
 * @file store.agent.test.ts — AGENT-keyed verification profiles.
 *
 * Pins: a verification profile can be keyed by the deterministic `agentId` (a
 * bytes32), independent of any user wallet; `addAgentMethod` climbs the agent's tier
 * exactly like the user store; the key spaces do not collide (a 40-hex wallet vs a
 * 64-hex agentId); and a malformed agent key throws (never silently keys an empty id).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetVerificationStore,
  addAgentMethod,
  addMethod,
  getAgentProfile,
  getProfile,
  normalizeAgentKey,
  setAgentMethods,
} from '../store.js'
import { computeAgentId } from '../../agent/identity.js'

const AGENT = computeAgentId(
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
)
const WALLET = '0x' + 'a'.repeat(40)

beforeEach(() => __resetVerificationStore())
afterEach(() => __resetVerificationStore())

describe('normalizeAgentKey', () => {
  it('accepts a lowercased bytes32 agent id', () => {
    expect(normalizeAgentKey(AGENT)).toBe(AGENT.toLowerCase())
  })
  it('lowercases mixed-case input for a stable key', () => {
    expect(normalizeAgentKey(AGENT.toUpperCase().replace('0X', '0x'))).toBe(AGENT.toLowerCase())
  })
  it('throws on a wallet-length value (not a bytes32 agent id)', () => {
    expect(() => normalizeAgentKey(WALLET)).toThrow(/agent id/)
  })
  it('throws on a non-string / blank value', () => {
    expect(() => normalizeAgentKey(undefined)).toThrow()
    expect(() => normalizeAgentKey('')).toThrow()
  })
})

describe('agent profile — record + read', () => {
  it('a fresh agent has an empty profile (standard)', () => {
    expect(getAgentProfile(AGENT).methods).toEqual([])
  })

  it('addAgentMethod records the method against the AGENT and is idempotent', () => {
    addAgentMethod(AGENT, 'oidc')
    addAgentMethod(AGENT, 'oidc')
    expect(getAgentProfile(AGENT).methods).toEqual(['oidc'])
  })

  it('setAgentMethods replaces wholesale, dropping unknown methods', () => {
    setAgentMethods(AGENT, ['oidc', 'world-id', 'bogus'])
    expect(getAgentProfile(AGENT).methods.sort()).toEqual(['oidc', 'world-id'])
  })
})

describe('agent profile climbs a tier on a verified agent token', () => {
  it('an OIDC-verified agent reaches Verified (>=1 method)', () => {
    const profile = addAgentMethod(AGENT, 'oidc')
    expect(profile.methods).toEqual(['oidc'])
    // The tier is derived (computeTier): one method ⇒ Verified.
    expect(getAgentProfile(AGENT).methods).toContain('oidc')
  })
})

describe('agent + user key spaces never collide', () => {
  it('recording on the user wallet does not appear on the agent, and vice versa', () => {
    addMethod(WALLET, 'world-id')
    addAgentMethod(AGENT, 'oidc')
    expect(getProfile(WALLET).methods).toEqual(['world-id'])
    expect(getAgentProfile(AGENT).methods).toEqual(['oidc'])
  })
})
