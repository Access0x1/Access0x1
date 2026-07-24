/**
 * @file grantConfig.test.ts — the three-field agent setup brain (pure).
 * Proves: allowlist canonicalizes to the exact origins the pay route matches,
 * caps validate/clamp, and the warnings tell an operator the honest state.
 */
import { describe, expect, it } from 'vitest'
import {
  buildAgentGrantConfig,
  normalizeAllowlist,
  parseCapUsd,
  toEnvLines,
} from '../grantConfig'

describe('normalizeAllowlist — matches the pay route (new URL().origin)', () => {
  it('canonicalizes trailing slashes, paths, case, and bare hosts (then dedups)', () => {
    const { origins } = normalizeAllowlist([
      'https://api.x.com/',
      'https://api.x.com/v1/pay', // same origin, different path → collapses
      'API.x.com', // bare host → https://api.x.com (same origin again)
      'http://localhost:8787',
    ])
    expect(origins).toEqual(['https://api.x.com', 'http://localhost:8787'])
  })

  it('dedups collapsed origins', () => {
    const { origins } = normalizeAllowlist('https://a.com, https://a.com/x, a.com')
    expect(origins).toEqual(['https://a.com'])
  })

  it('accepts a comma OR newline list', () => {
    const { origins } = normalizeAllowlist('https://a.com\nhttps://b.com')
    expect(origins).toEqual(['https://a.com', 'https://b.com'])
  })

  it('rejects un-parseable tokens (never a silent bad entry)', () => {
    const { origins, rejected } = normalizeAllowlist('https://ok.com, not a url, @@@')
    expect(origins).toEqual(['https://ok.com'])
    expect(rejected).toEqual(['not a url', '@@@'])
  })
})

describe('parseCapUsd', () => {
  it('accepts finite non-negative numbers and strings', () => {
    expect(parseCapUsd('25')).toBe(25)
    expect(parseCapUsd(0)).toBe(0)
    expect(parseCapUsd('2.5')).toBe(2.5)
  })
  it('rejects negatives, NaN, empty → null', () => {
    expect(parseCapUsd('-1')).toBeNull()
    expect(parseCapUsd('abc')).toBeNull()
    expect(parseCapUsd('')).toBeNull()
    expect(parseCapUsd(undefined)).toBeNull()
  })
})

describe('buildAgentGrantConfig', () => {
  it('builds a clean config from the three fields', () => {
    const c = buildAgentGrantConfig({
      walletId: 'wal_123',
      dailyCapUsd: '50',
      allowlist: 'https://api.x.com/, api.y.com',
    })
    expect(c.walletId).toBe('wal_123')
    expect(c.dailyCapUsd).toBe(50)
    expect(c.allowlist).toEqual(['https://api.x.com', 'https://api.y.com'])
    expect(c.warnings).toEqual([])
  })

  it('warns honestly on the blocking states (no wallet, 0 cap, empty allowlist)', () => {
    const c = buildAgentGrantConfig({})
    expect(c.dailyCapUsd).toBe(0)
    expect(c.allowlist).toEqual([])
    expect(c.warnings.join(' ')).toMatch(/wallet/i)
    expect(c.warnings.join(' ')).toMatch(/cap is 0/i)
    expect(c.warnings.join(' ')).toMatch(/allowlist is empty/i)
  })

  it('warns when a cap string is non-numeric (defaults to 0)', () => {
    const c = buildAgentGrantConfig({ walletId: 'w', dailyCapUsd: 'lots', allowlist: 'https://a.com' })
    expect(c.dailyCapUsd).toBe(0)
    expect(c.warnings.join(' ')).toMatch(/valid number/i)
  })

  it('surfaces dropped allowlist entries', () => {
    const c = buildAgentGrantConfig({ walletId: 'w', dailyCapUsd: '10', allowlist: 'https://a.com, junk' })
    expect(c.rejectedAllowlist).toEqual(['junk'])
    expect(c.warnings.join(' ')).toMatch(/not a valid url/i)
  })
})

describe('toEnvLines', () => {
  it('emits the exact AGENT_* lines with normalized values (no secrets)', () => {
    const c = buildAgentGrantConfig({ walletId: 'w1', dailyCapUsd: '20', allowlist: 'api.x.com/' })
    expect(toEnvLines(c)).toBe(
      ['AGENT_WALLET_ID=w1', 'AGENT_DAILY_USD_CAP=20', 'AGENT_URL_ALLOWLIST=https://api.x.com'].join('\n'),
    )
  })
})
