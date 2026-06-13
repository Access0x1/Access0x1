/**
 * @file config.test.ts — the OIDC env seam (generic, vendor-agnostic).
 *
 * Pins: defaults verify Sign-in-with-Google ID tokens out of the box; every value
 * is overridable via env to point at ANY OIDC provider or the operator's own
 * backend; and `isOidcConfigured` gates on the audience (client id) — no audience
 * ⇒ OIDC is off (fail-soft, never a faked pass).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_OIDC_ISSUER,
  DEFAULT_OIDC_JWKS_URL,
  isOidcConfigured,
  oidcAgentClaim,
  oidcAudience,
  oidcIssuer,
  oidcJwksUrl,
} from '../config'

const OIDC_ENV = [
  'OIDC_ISSUER',
  'OIDC_JWKS_URL',
  'OIDC_AUDIENCE',
  'OIDC_AGENT_CLAIM',
  'NEXT_PUBLIC_OIDC_CLIENT_ID',
] as const

function clearOidcEnv(): void {
  for (const k of OIDC_ENV) delete process.env[k]
}

beforeEach(clearOidcEnv)
afterEach(clearOidcEnv)

describe('defaults (Sign in with Google out of the box)', () => {
  it('issuer + JWKS url fall back to the public Google standards values', () => {
    expect(oidcIssuer()).toBe(DEFAULT_OIDC_ISSUER)
    expect(oidcJwksUrl()).toBe(DEFAULT_OIDC_JWKS_URL)
  })
  it('agent claim defaults to a readable name', () => {
    expect(oidcAgentClaim()).toBe('agent_id')
  })
  it('audience is empty until a client id is set (⇒ unconfigured)', () => {
    expect(oidcAudience()).toBe('')
    expect(isOidcConfigured()).toBe(false)
  })
})

describe('env overrides (any OIDC provider / own backend)', () => {
  it('overrides issuer, jwks url, and agent claim', () => {
    process.env.OIDC_ISSUER = 'https://id.example.com'
    process.env.OIDC_JWKS_URL = 'https://id.example.com/keys'
    process.env.OIDC_AGENT_CLAIM = 'act'
    expect(oidcIssuer()).toBe('https://id.example.com')
    expect(oidcJwksUrl()).toBe('https://id.example.com/keys')
    expect(oidcAgentClaim()).toBe('act')
  })

  it('audience comes from NEXT_PUBLIC_OIDC_CLIENT_ID, configured ⇒ true', () => {
    process.env.NEXT_PUBLIC_OIDC_CLIENT_ID = 'client-123'
    expect(oidcAudience()).toBe('client-123')
    expect(isOidcConfigured()).toBe(true)
  })

  it('OIDC_AUDIENCE overrides the public client id when both are set', () => {
    process.env.NEXT_PUBLIC_OIDC_CLIENT_ID = 'public-id'
    process.env.OIDC_AUDIENCE = 'server-aud'
    expect(oidcAudience()).toBe('server-aud')
  })
})
