/**
 * sealedEnv.test.ts — the encrypted keystore.
 *
 * This code guards every credential the deployment has, so the tests are about
 * the security properties, not just the happy path: authentication must reject
 * tampering, a wrong passphrase must never yield plaintext, the error must not
 * say WHICH half was wrong, and env precedence must let a deploy override a
 * sealed value without re-sealing.
 */
import { describe, expect, it } from 'vitest'

import {
  MIN_PASSPHRASE_LENGTH,
  SealedEnvError,
  applyToEnv,
  constantTimeEqual,
  open,
  parseDotenv,
  seal,
} from '../sealedEnv'

const PASS = 'correct-horse-battery-staple-42'
const ENV_TEXT = `# comment
CLAUDE_API_KEY=sk-secret-value
AGENT_DAILY_USD_CAP=25
QUOTED="a value with spaces"

EMPTY=
`

describe('seal / open round-trip', () => {
  it('returns exactly what went in', () => {
    expect(open(seal(ENV_TEXT, PASS), PASS)).toBe(ENV_TEXT)
  })

  it('never produces the same bytes twice (random salt + IV)', () => {
    const a = seal(ENV_TEXT, PASS)
    const b = seal(ENV_TEXT, PASS)
    expect(a.data).not.toBe(b.data)
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
  })

  it('the sealed payload does not contain the plaintext', () => {
    const sealed = JSON.stringify(seal(ENV_TEXT, PASS))
    expect(sealed).not.toContain('sk-secret-value')
    expect(sealed).not.toContain('CLAUDE_API_KEY')
  })
})

describe('it fails closed', () => {
  it('a wrong passphrase throws instead of returning garbage', () => {
    const sealed = seal(ENV_TEXT, PASS)
    expect(() => open(sealed, 'wrong-passphrase-but-long-enough')).toThrow(SealedEnvError)
  })

  it('does not reveal WHICH failure occurred (wrong key vs tampering)', () => {
    const sealed = seal(ENV_TEXT, PASS)
    const wrongPass = (() => {
      try {
        open(sealed, 'wrong-passphrase-but-long-enough')
      } catch (e) {
        return (e as Error).message
      }
    })()
    const tampered = (() => {
      const bytes = Buffer.from(sealed.data, 'base64')
      bytes[0] ^= 0xff
      try {
        open({ ...sealed, data: bytes.toString('base64') }, PASS)
      } catch (e) {
        return (e as Error).message
      }
    })()
    // Identical messages: an attacker learns nothing about which half was right.
    expect(wrongPass).toBe(tampered)
  })

  it('rejects a modified authentication tag', () => {
    const sealed = seal(ENV_TEXT, PASS)
    const tag = Buffer.from(sealed.tag, 'base64')
    tag[0] ^= 0xff
    expect(() => open({ ...sealed, tag: tag.toString('base64') }, PASS)).toThrow(SealedEnvError)
  })

  it('rejects an unknown format version rather than guessing', () => {
    expect(() => open({ ...seal(ENV_TEXT, PASS), version: 99 }, PASS)).toThrow(/version/)
  })

  it('refuses a passphrase short enough to brute-force offline', () => {
    expect(() => seal(ENV_TEXT, 'short')).toThrow(SealedEnvError)
    expect(() => seal(ENV_TEXT, 'x'.repeat(MIN_PASSPHRASE_LENGTH))).not.toThrow()
  })
})

describe('parseDotenv', () => {
  it('reads pairs, skips comments and blanks, strips matched quotes', () => {
    const parsed = parseDotenv(ENV_TEXT)
    expect(parsed.get('CLAUDE_API_KEY')).toBe('sk-secret-value')
    expect(parsed.get('AGENT_DAILY_USD_CAP')).toBe('25')
    expect(parsed.get('QUOTED')).toBe('a value with spaces')
    expect(parsed.get('EMPTY')).toBe('')
    expect(parsed.has('# comment')).toBe(false)
  })
})

describe('applyToEnv — a real env var always wins', () => {
  it('fills only what is unset, so a deploy can override one key without re-sealing', () => {
    const env: Record<string, string | undefined> = { CLAUDE_API_KEY: 'from-deploy-provider' }
    const applied = applyToEnv(ENV_TEXT, env)
    expect(env.CLAUDE_API_KEY).toBe('from-deploy-provider')
    expect(env.AGENT_DAILY_USD_CAP).toBe('25')
    expect(applied).not.toContain('CLAUDE_API_KEY')
    expect(applied).toContain('AGENT_DAILY_USD_CAP')
  })

  it('treats an empty existing value as unset', () => {
    const env: Record<string, string | undefined> = { AGENT_DAILY_USD_CAP: '' }
    applyToEnv(ENV_TEXT, env)
    expect(env.AGENT_DAILY_USD_CAP).toBe('25')
  })

  it('returns NAMES only, never values (safe to log)', () => {
    const env: Record<string, string | undefined> = {}
    const applied = applyToEnv(ENV_TEXT, env)
    expect(applied.join(',')).not.toContain('sk-secret-value')
  })
})

describe('constantTimeEqual', () => {
  it('compares correctly', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
})
