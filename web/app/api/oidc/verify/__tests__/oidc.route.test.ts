/**
 * @file oidc.route.test.ts — the /api/oidc/verify route (Sign in with Google).
 *
 * Pins: POST verifies the OIDC ID token for real (verify mocked), dedups the OIDC
 * account (one issuer+subject verifies once → 409 on a repeat), records the `oidc`
 * method so the tier climbs, and echoes the verified user + agent ("verify for
 * all"). A failed/unconfigured verify records NOTHING. The verify lib + subject
 * store are mocked so the suite is offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyOidcToken = vi.fn()
vi.mock('@/lib/oidc/verify', () => ({
  verifyOidcToken: (token: unknown) => verifyOidcToken(token),
}))

vi.mock('@/lib/oidc/config', () => ({ oidcIssuer: () => 'https://accounts.google.com' }))

// Caller-binding seam (shared lib/verification/callerBinding → lib/branding/tenant). Kept
// on the booth fallback (verified:false) so the existing tests run the OPEN flow; the
// production caller-binding tests drive it via BRANDING_REQUIRE_VERIFIED_WRITES.
vi.mock('@/lib/branding/tenant', async () => {
  class TenantAuthError extends Error {}
  return {
    TenantAuthError,
    resolveVerifiedTenant: vi.fn(async (_req: Request, body: { tenantId?: string }) => {
      const id = (body?.tenantId ?? '').toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(id)) throw new TenantAuthError()
      return { tenantId: id, verified: false }
    }),
    requireVerifiedWrites: vi.fn(() => {
      const f = (process.env.BRANDING_REQUIRE_VERIFIED_WRITES ?? '').trim().toLowerCase()
      if (f === 'true') return true
      if (f === 'false') return false
      return process.env.NODE_ENV === 'production'
    }),
  }
})

const { POST, GET } = await import('../route.js')
const store = await import('@/lib/verification/store')
const subjects = await import('@/lib/oidc/subjectStore')
const tenant = await import('@/lib/branding/tenant')

const USER = '0x' + '1'.repeat(40)

function post(body: unknown): Request {
  return new Request('https://x/api/oidc/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  store.__resetVerificationStore()
  subjects.__resetSubjectStore()
  verifyOidcToken.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/oidc/verify — input guards', () => {
  it('400 invalid json', async () => {
    const bad = new Request('https://x/api/oidc/verify', { method: 'POST', body: '{x' })
    expect((await POST(bad)).status).toBe(400)
  })
  it('400 bad user', async () => {
    expect((await POST(post({ user: 'nope', token: 't' }))).status).toBe(400)
  })
})

describe('POST /api/oidc/verify — verify outcomes', () => {
  it('records `oidc` and returns Verified on a valid token', async () => {
    verifyOidcToken.mockResolvedValue({
      ok: true,
      identity: { subject: 'sub-1', email: 'a@b.c', agent: null },
    })
    const res = await POST(post({ user: USER, token: 'good.jwt' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.methods).toEqual(['oidc'])
    expect(json.tier).toBe('verified')
    expect(json.oidc).toEqual({ subject: 'sub-1', email: 'a@b.c', agent: null })
    expect(verifyOidcToken).toHaveBeenCalledWith('good.jwt')
  })

  it('verify for all: echoes the verified agent claim', async () => {
    verifyOidcToken.mockResolvedValue({
      ok: true,
      identity: { subject: 'sub-2', email: null, agent: 'agent-007' },
    })
    const json = await (await POST(post({ user: USER, token: 'good.jwt' }))).json()
    expect(json.oidc.agent).toBe('agent-007')
  })

  it('accepts the OIDC-native id_token field name', async () => {
    verifyOidcToken.mockResolvedValue({
      ok: true,
      identity: { subject: 'sub-3', email: null, agent: null },
    })
    await POST(post({ user: USER, id_token: 'raw.id.token' }))
    expect(verifyOidcToken).toHaveBeenCalledWith('raw.id.token')
  })

  it('503 not_configured (booth-gated) records nothing', async () => {
    verifyOidcToken.mockResolvedValue({ ok: false, code: 'not_configured' })
    const res = await POST(post({ user: USER, token: 'x' }))
    expect(res.status).toBe(503)
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('401 token_invalid records nothing', async () => {
    verifyOidcToken.mockResolvedValue({ ok: false, code: 'token_invalid' })
    const res = await POST(post({ user: USER, token: 'forged' }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('token_invalid')
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('502 jwks_unreachable records nothing (fail-soft)', async () => {
    verifyOidcToken.mockResolvedValue({ ok: false, code: 'jwks_unreachable' })
    expect((await POST(post({ user: USER, token: 'x' }))).status).toBe(502)
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('400 missing_token', async () => {
    verifyOidcToken.mockResolvedValue({ ok: false, code: 'missing_token' })
    expect((await POST(post({ user: USER }))).status).toBe(400)
  })
})

describe('POST /api/oidc/verify — one-account-per-subject dedup', () => {
  it('409 when the SAME OIDC account is re-claimed (and not double-recorded)', async () => {
    verifyOidcToken.mockResolvedValue({
      ok: true,
      identity: { subject: 'dup-sub', email: null, agent: null },
    })
    const first = await POST(post({ user: USER, token: 't' }))
    expect(first.status).toBe(200)

    // A different wallet trying to claim the SAME Google account is rejected.
    const OTHER = '0x' + '2'.repeat(40)
    const second = await POST(post({ user: OTHER, token: 't' }))
    expect(second.status).toBe(409)
    expect((await second.json()).error).toBe('already_verified')
    expect(store.getProfile(OTHER).methods).toEqual([])
  })
})

describe('POST /api/oidc/verify — caller-binding (anti-farm) in production', () => {
  // The `oidc` badge is recorded here too, so binding it ONLY on /api/verify would leave
  // this route as a trivial bypass. In production the caller must control `user`.
  beforeEach(() => {
    process.env.BRANDING_REQUIRE_VERIFIED_WRITES = 'true'
  })
  afterEach(() => {
    delete process.env.BRANDING_REQUIRE_VERIFIED_WRITES
  })

  it('401 for an unverified caller — token never verified, nothing recorded', async () => {
    verifyOidcToken.mockResolvedValue({
      ok: true,
      identity: { subject: 'farm-sub', email: null, agent: null },
    })
    const res = await POST(post({ user: USER, token: 'good.jwt' }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unverified_caller')
    // The gate runs BEFORE token verification — no subject slot burned, nothing recorded.
    expect(verifyOidcToken).not.toHaveBeenCalled()
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('records `oidc` when the caller holds a verified session for `user`', async () => {
    vi.mocked(tenant.resolveVerifiedTenant).mockResolvedValueOnce({ tenantId: USER, verified: true })
    verifyOidcToken.mockResolvedValue({
      ok: true,
      identity: { subject: 'ok-sub', email: null, agent: null },
    })
    const res = await POST(post({ user: USER, token: 'good.jwt' }))
    expect(res.status).toBe(200)
    expect((await res.json()).methods).toEqual(['oidc'])
  })
})

describe('GET /api/oidc/verify', () => {
  it('400 on a bad user', async () => {
    expect((await GET(new Request('https://x/api/oidc/verify?user=nope'))).status).toBe(400)
  })
  it('reads the current profile (standard/empty for a fresh user)', async () => {
    const json = await (await GET(new Request(`https://x/api/oidc/verify?user=${USER}`))).json()
    expect(json).toMatchObject({ user: USER, methods: [], tier: 'standard', score: 0 })
  })
})
