/**
 * @file verify.test.ts — server-side OIDC ("Sign in with Google") token verify.
 *
 * The route must NOT trust a client-asserted identity: `verifyOidcToken` verifies
 * the ID token's signature against the issuer's JWKS (via jose) and pins `iss` +
 * `aud`, returning the verified user (`sub`/`email`) and, when present, a verified
 * agent claim — "verify for all". jose is mocked so these run offline; the mock
 * stands in for the JWKS fetch + RS256 verification, and we assert that the
 * configured issuer/audience are passed through to `jwtVerify` (so a wrong
 * issuer/audience token is rejected by jose, exactly as in production).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jwtVerify = vi.fn()
const createRemoteJWKSet = vi.fn((url: URL) => {
  void url
  return 'JWKS'
})
vi.mock('jose', () => ({
  createRemoteJWKSet: (url: URL) => createRemoteJWKSet(url),
  jwtVerify: (...args: unknown[]) => jwtVerify(...args),
}))

import { verifyOidcToken, __resetOidcJwksForTests } from '../verify'
import { DEFAULT_OIDC_ISSUER, DEFAULT_OIDC_JWKS_URL } from '../config'

const CLIENT_ID = 'client-abc.apps.example'

beforeEach(() => {
  jwtVerify.mockReset()
  createRemoteJWKSet.mockClear()
  __resetOidcJwksForTests()
  delete process.env.OIDC_ISSUER
  delete process.env.OIDC_JWKS_URL
  delete process.env.OIDC_AUDIENCE
  delete process.env.OIDC_AGENT_CLAIM
  delete process.env.NEXT_PUBLIC_OIDC_CLIENT_ID
})
afterEach(() => {
  vi.clearAllMocks()
  delete process.env.OIDC_ISSUER
  delete process.env.OIDC_JWKS_URL
  delete process.env.OIDC_AUDIENCE
  delete process.env.OIDC_AGENT_CLAIM
  delete process.env.NEXT_PUBLIC_OIDC_CLIENT_ID
})

describe('verifyOidcToken — unconfigured (booth-gated, fail-soft)', () => {
  it('not_configured when no audience/client id is set, never calls jwtVerify', async () => {
    const out = await verifyOidcToken('any.jwt')
    expect(out).toEqual({ ok: false, code: 'not_configured' })
    expect(jwtVerify).not.toHaveBeenCalled()
  })
})

describe('verifyOidcToken — configured (happy path)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_OIDC_CLIENT_ID = CLIENT_ID
  })

  it('verifies the user (sub + email) and passes the DEFAULT issuer/audience to jose', async () => {
    jwtVerify.mockResolvedValue({
      payload: { sub: 'google-sub-123', email: 'alice@example.com' },
    })
    const out = await verifyOidcToken('good.id.token')
    expect(out).toEqual({
      ok: true,
      identity: { subject: 'google-sub-123', email: 'alice@example.com', agent: null },
    })
    // The JWKS is built from the default (Google) certs URL...
    expect(createRemoteJWKSet).toHaveBeenCalledWith(new URL(DEFAULT_OIDC_JWKS_URL))
    // ...and the default Google issuer + configured audience are PINNED.
    expect(jwtVerify).toHaveBeenCalledWith('good.id.token', 'JWKS', {
      issuer: DEFAULT_OIDC_ISSUER,
      audience: CLIENT_ID,
    })
  })

  it('verify for all: extracts an agent id when the token carries the agent claim', async () => {
    jwtVerify.mockResolvedValue({
      payload: { sub: 'sub-1', email: 'a@b.c', agent_id: 'agent-007' },
    })
    const out = await verifyOidcToken('good.jwt')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.identity.agent).toBe('agent-007')
  })

  it('honors a custom agent claim name from env', async () => {
    process.env.OIDC_AGENT_CLAIM = 'act'
    jwtVerify.mockResolvedValue({ payload: { sub: 'sub-1', act: 'agent-act' } })
    const out = await verifyOidcToken('good.jwt')
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.identity.agent).toBe('agent-act')
      expect(out.identity.email).toBeNull()
    }
  })

  it('missing_token when no token string is supplied', async () => {
    expect(await verifyOidcToken(undefined)).toEqual({ ok: false, code: 'missing_token' })
    expect(await verifyOidcToken('')).toEqual({ ok: false, code: 'missing_token' })
    expect(jwtVerify).not.toHaveBeenCalled()
  })

  it('token_invalid when a verified token carries no sub', async () => {
    jwtVerify.mockResolvedValue({ payload: { email: 'a@b.c' } })
    expect(await verifyOidcToken('good.jwt')).toEqual({ ok: false, code: 'token_invalid' })
  })
})

describe('verifyOidcToken — rejects a bad token (jose throws)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_OIDC_CLIENT_ID = CLIENT_ID
  })

  it('token_invalid on a wrong-issuer token (jose rejects the iss claim)', async () => {
    // jose throws when the iss does not match the pinned issuer.
    jwtVerify.mockRejectedValue(
      Object.assign(new Error('unexpected "iss" claim value'), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' }),
    )
    expect(await verifyOidcToken('wrong.issuer.jwt')).toEqual({ ok: false, code: 'token_invalid' })
  })

  it('token_invalid on a wrong-audience token (jose rejects the aud claim)', async () => {
    jwtVerify.mockRejectedValue(
      Object.assign(new Error('unexpected "aud" claim value'), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' }),
    )
    expect(await verifyOidcToken('wrong.aud.jwt')).toEqual({ ok: false, code: 'token_invalid' })
  })

  it('token_invalid on a bad signature', async () => {
    jwtVerify.mockRejectedValue(new Error('signature verification failed'))
    expect(await verifyOidcToken('forged.jwt')).toEqual({ ok: false, code: 'token_invalid' })
  })

  it('jwks_unreachable when the JWKS keys cannot be fetched (fail-soft)', async () => {
    jwtVerify.mockRejectedValue(
      Object.assign(new Error('request timed out'), { code: 'ERR_JWKS_TIMEOUT' }),
    )
    expect(await verifyOidcToken('any.jwt')).toEqual({ ok: false, code: 'jwks_unreachable' })
  })
})

describe('verifyOidcToken — custom provider via env (generic, any OIDC issuer)', () => {
  it('uses the configured issuer + JWKS url + audience override', async () => {
    process.env.OIDC_ISSUER = 'https://issuer.example.com'
    process.env.OIDC_JWKS_URL = 'https://issuer.example.com/jwks'
    process.env.OIDC_AUDIENCE = 'custom-aud'
    jwtVerify.mockResolvedValue({ payload: { sub: 'sub-9' } })

    const out = await verifyOidcToken('tok')
    expect(out.ok).toBe(true)
    expect(createRemoteJWKSet).toHaveBeenCalledWith(new URL('https://issuer.example.com/jwks'))
    expect(jwtVerify).toHaveBeenCalledWith('tok', 'JWKS', {
      issuer: 'https://issuer.example.com',
      audience: 'custom-aud',
    })
  })
})
