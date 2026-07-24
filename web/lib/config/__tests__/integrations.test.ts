/**
 * @file integrations.test.ts — the credential registry (pure).
 * Proves the three states (configured / partial / off), that "partial" catches the
 * dangerous half-configured middle, and that no status object ever carries a VALUE.
 */
import { describe, expect, it } from 'vitest'
import {
  INTEGRATIONS,
  allKnownVarNames,
  allStatuses,
  getIntegration,
  isSet,
  secretVarNames,
  statusOf,
  type EnvLookup,
} from '../integrations'

/** Build a lookup from a plain object. */
const env =
  (obj: Record<string, string>): EnvLookup =>
  (name) =>
    obj[name]

describe('registry shape', () => {
  it('every integration has a unique id, a label, a source, and at least one var', () => {
    const ids = INTEGRATIONS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const i of INTEGRATIONS) {
      expect(i.label.length, i.id).toBeGreaterThan(0)
      expect(i.unlocks.length, i.id).toBeGreaterThan(0)
      expect(i.where.length, i.id).toBeGreaterThan(0)
      expect(i.vars.length, i.id).toBeGreaterThan(0)
    }
  })

  it('every var name is SCREAMING_SNAKE (matches .env.example convention)', () => {
    for (const name of allKnownVarNames()) {
      expect(name, name).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it('secrets are declared and never include a NEXT_PUBLIC_ var (client-exposed)', () => {
    const secrets = secretVarNames()
    expect(secrets.length).toBeGreaterThan(0)
    for (const s of secrets) expect(s.startsWith('NEXT_PUBLIC_'), s).toBe(false)
  })

  it('getIntegration finds by id, undefined otherwise', () => {
    expect(getIntegration('uniswap')?.label).toContain('Uniswap')
    expect(getIntegration('nope')).toBeUndefined()
  })
})

describe('isSet', () => {
  it('treats blank / whitespace / undefined as unset', () => {
    expect(isSet('x')).toBe(true)
    expect(isSet('')).toBe(false)
    expect(isSet('   ')).toBe(false)
    expect(isSet(undefined)).toBe(false)
  })
})

describe('statusOf — the three states', () => {
  const uniswap = getIntegration('uniswap')!

  it('off: nothing set', () => {
    const s = statusOf(uniswap, env({}))
    expect(s.state).toBe('off')
    expect(s.ready).toBe(false)
    expect(s.missingRequired).toContain('UNISWAP_TRADING_API_URL')
  })

  it('configured: every required var set', () => {
    const s = statusOf(uniswap, env({ UNISWAP_TRADING_API_URL: 'https://api', UNISWAP_TRADING_API_KEY: 'k' }))
    expect(s.state).toBe('configured')
    expect(s.ready).toBe(true)
    expect(s.missingRequired).toEqual([])
  })

  it('partial: something set but a REQUIRED var missing (the silent-failure trap)', () => {
    // Key set, URL missing — looks configured at a glance, would never work.
    const s = statusOf(uniswap, env({ UNISWAP_TRADING_API_KEY: 'k' }))
    expect(s.state).toBe('partial')
    expect(s.ready).toBe(false)
    expect(s.missingRequired).toEqual(['UNISWAP_TRADING_API_URL'])
  })

  it('reports an unset OPTIONAL var so a green check is never an overclaim', () => {
    const s = statusOf(uniswap, env({ UNISWAP_TRADING_API_URL: 'https://api' }))
    expect(s.state).toBe('configured')
    expect(s.missingOptional).toContain('UNISWAP_TRADING_API_KEY')
  })

  it('a blank string counts as unset (not "configured")', () => {
    const s = statusOf(uniswap, env({ UNISWAP_TRADING_API_URL: '   ' }))
    expect(s.ready).toBe(false)
  })
})

describe('allStatuses — safe to serialize', () => {
  it('returns one status per integration and leaks NO values', () => {
    const secret = 'sk-super-secret-value'
    const statuses = allStatuses(env({ CLAUDE_API_KEY: secret, UNISWAP_TRADING_API_URL: 'https://api' }))
    expect(statuses.length).toBe(INTEGRATIONS.length)
    // The whole serialized payload must never contain a configured value.
    expect(JSON.stringify(statuses)).not.toContain(secret)
  })
})
