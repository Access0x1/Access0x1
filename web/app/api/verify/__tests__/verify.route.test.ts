/**
 * @file verify.route.test.ts — the Super Verification API route.
 *
 * Pins: GET reads the derived profile/tier; POST verifies ONE method for real
 * and records it; each method's failure maps to a clear code/status; the tier
 * climbs as methods compose; nothing is faked (a failed real check never records
 * the method). All collaborators (World ID portal, ENS, jose, on-chain client)
 * are mocked so the suite is offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock the real-check collaborators ─────────────────────────────────────────
const verifyWorldProof = vi.fn<(proof: unknown, action: string) => unknown>()
vi.mock('@/lib/worldid/verify', () => ({
  verifyWorldProof: (proof: unknown, action: string) => verifyWorldProof(proof, action),
}))

const claimNullifier = vi.fn<(action: string, nullifier: string) => boolean>(() => true)
vi.mock('@/lib/worldid/nullifierStore', () => ({
  claimNullifier: (action: string, nullifier: string) => claimNullifier(action, nullifier),
}))

vi.mock('@/lib/worldid/config', () => ({ worldAction: () => 'ax1-buyer' }))

const resolveENS = vi.fn<(input: string, chainId: number) => Promise<string>>()
class EnsResolutionError extends Error {}
vi.mock('@/lib/ens', () => ({
  resolveENS: (input: string, chainId: number) => resolveENS(input, chainId),
  EnsResolutionError,
}))

const getBalance = vi.fn<() => Promise<bigint>>()
const getTransactionCount = vi.fn<() => Promise<number>>()
vi.mock('@/lib/wallet', () => ({
  getPublicClient: () => ({ getBalance, getTransactionCount }),
}))

vi.mock('@/lib/chains', () => ({ getDefaultChainId: () => 5042002 }))

// Dynamic JWT path: keep it on the booth-gated fallback (no issuer) so a
// matching body user verifies in the demo.
vi.mock('@/lib/branding/tenant', async () => {
  class TenantAuthError extends Error {}
  return {
    TenantAuthError,
    resolveVerifiedTenant: vi.fn(async (_req: Request, body: { tenantId?: string }) => {
      const id = (body?.tenantId ?? '').toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(id)) throw new TenantAuthError()
      return { tenantId: id, verified: false }
    }),
    // Mirrors the real policy so the fail-closed test can drive it via the flag.
    requireVerifiedWrites: vi.fn(() => {
      const f = (process.env.BRANDING_REQUIRE_VERIFIED_WRITES ?? '').trim().toLowerCase()
      if (f === 'true') return true
      if (f === 'false') return false
      return process.env.NODE_ENV === 'production'
    }),
  }
})

const { GET, POST } = await import('../route.js')
const store = await import('@/lib/verification/store')
const tenant = await import('@/lib/branding/tenant')

const USER = '0x' + '1'.repeat(40)

function post(body: unknown): Request {
  return new Request('https://x/api/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  store.__resetVerificationStore()
  verifyWorldProof.mockReset()
  claimNullifier.mockReset()
  claimNullifier.mockReturnValue(true)
  resolveENS.mockReset()
  getBalance.mockReset()
  getTransactionCount.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/verify', () => {
  it('400 on a bad user', async () => {
    const res = await GET(new Request('https://x/api/verify?user=nope'))
    expect(res.status).toBe(400)
  })
  it('empty profile -> standard, score 0', async () => {
    const res = await GET(new Request(`https://x/api/verify?user=${USER}`))
    const json = await res.json()
    expect(json).toMatchObject({ user: USER, methods: [], tier: 'standard', score: 0 })
  })
})

describe('POST /api/verify — input guards', () => {
  it('400 invalid json', async () => {
    const bad = new Request('https://x/api/verify', { method: 'POST', body: '{x' })
    expect((await POST(bad)).status).toBe(400)
  })
  it('400 bad user / bad method', async () => {
    expect((await POST(post({ user: 'nope', method: 'ens' }))).status).toBe(400)
    expect((await POST(post({ user: USER, method: 'mystery' }))).status).toBe(400)
  })
})

describe('POST world-id', () => {
  it('records on a fresh verified proof -> verified tier', async () => {
    verifyWorldProof.mockResolvedValue({ ok: true, nullifier: '123', action: 'ax1-buyer' })
    const res = await POST(post({ user: USER, method: 'world-id', proof: { merkle_root: '0x' } }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.methods).toEqual(['world-id'])
    expect(json.tier).toBe('verified')
    expect(claimNullifier).toHaveBeenCalledWith('ax1-buyer', '123')
  })

  it('does NOT record when the portal rejects the proof (401)', async () => {
    verifyWorldProof.mockResolvedValue({ ok: false, code: 'verification_failed' })
    const res = await POST(post({ user: USER, method: 'world-id', proof: {} }))
    expect(res.status).toBe(401)
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('503 when World ID is not configured (booth-gated)', async () => {
    verifyWorldProof.mockResolvedValue({ ok: false, code: 'not_configured' })
    const res = await POST(post({ user: USER, method: 'world-id', proof: {} }))
    expect(res.status).toBe(503)
  })

  it('409 on a repeat human (already_verified, not recorded)', async () => {
    verifyWorldProof.mockResolvedValue({ ok: true, nullifier: '123', action: 'ax1-buyer' })
    claimNullifier.mockReturnValue(false)
    const res = await POST(post({ user: USER, method: 'world-id', proof: {} }))
    expect(res.status).toBe(409)
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('400 when no proof supplied', async () => {
    const res = await POST(post({ user: USER, method: 'world-id' }))
    expect(res.status).toBe(400)
  })

  it('C-2: ignores a body `action`, verifying against the SERVER buyer action', async () => {
    verifyWorldProof.mockResolvedValue({ ok: true, nullifier: '321', action: 'ax1-buyer' })
    // Attacker presents a proof but injects a different action in the body.
    const res = await POST(
      post({ user: USER, method: 'world-id', proof: { merkle_root: '0x' }, action: 'attacker-action' }),
    )
    expect(res.status).toBe(200)
    // verifyWorldProof MUST be called with the trusted server action, never the body's,
    // and the proof forwarded carries that same server action (no body override).
    expect(verifyWorldProof).toHaveBeenCalledTimes(1)
    const [forwardedProof, forwardedAction] = verifyWorldProof.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ]
    expect(forwardedAction).toBe('ax1-buyer')
    expect(forwardedAction).not.toBe('attacker-action')
    expect(forwardedProof.action).toBe('ax1-buyer')
    // The nullifier is claimed under the server action, not the body action.
    expect(claimNullifier).toHaveBeenCalledWith('ax1-buyer', '321')
  })
})

describe('POST ens (resolveENS first call-site)', () => {
  it('records when the ENS name forward-resolves to the user wallet', async () => {
    resolveENS.mockResolvedValue(USER)
    const res = await POST(post({ user: USER, method: 'ens', ensName: 'alice.eth' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.methods).toEqual(['ens'])
    expect(resolveENS).toHaveBeenCalledWith('alice.eth', 5042002)
  })

  it('401 ens_mismatch when the name resolves to a DIFFERENT wallet (anti-claim)', async () => {
    resolveENS.mockResolvedValue('0x' + '9'.repeat(40))
    const res = await POST(post({ user: USER, method: 'ens', ensName: 'vitalik.eth' }))
    const json = await res.json()
    expect(res.status).toBe(401)
    expect(json.error).toBe('ens_mismatch')
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('401 ens_unresolved when the name does not resolve', async () => {
    resolveENS.mockRejectedValue(new EnsResolutionError('no'))
    const res = await POST(post({ user: USER, method: 'ens', ensName: 'ghost.eth' }))
    expect((await res.json()).error).toBe('ens_unresolved')
  })

  it('400 when no ENS name supplied', async () => {
    expect((await POST(post({ user: USER, method: 'ens' }))).status).toBe(400)
  })
})

describe('POST dynamic', () => {
  it('records when the verified session matches the user', async () => {
    const res = await POST(post({ user: USER, method: 'dynamic' }))
    expect(res.status).toBe(200)
    expect((await res.json()).methods).toEqual(['dynamic'])
  })

  it('401 dynamic_unauthorized for a self-asserted (unverified) session in production', async () => {
    // The booth fallback would let anyone claim the Dynamic trust tier by naming
    // a wallet — which inflates the trust ladder gating trial pay. In production
    // it must require a real verified session.
    process.env.BRANDING_REQUIRE_VERIFIED_WRITES = 'true'
    try {
      const res = await POST(post({ user: USER, method: 'dynamic' }))
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('dynamic_unauthorized')
    } finally {
      delete process.env.BRANDING_REQUIRE_VERIFIED_WRITES
    }
  })
})

describe('POST onchain', () => {
  it('records a funded wallet', async () => {
    getBalance.mockResolvedValue(1n)
    getTransactionCount.mockResolvedValue(0)
    const res = await POST(post({ user: USER, method: 'onchain' }))
    expect(res.status).toBe(200)
  })
  it('records an active wallet (nonce > 0) even with 0 balance', async () => {
    getBalance.mockResolvedValue(0n)
    getTransactionCount.mockResolvedValue(3)
    const res = await POST(post({ user: USER, method: 'onchain' }))
    expect(res.status).toBe(200)
  })
  it('401 wallet_empty for a brand-new throwaway', async () => {
    getBalance.mockResolvedValue(0n)
    getTransactionCount.mockResolvedValue(0)
    const res = await POST(post({ user: USER, method: 'onchain' }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('wallet_empty')
  })
})

describe('POST caller-binding (anti-farm) — world-id / oidc / onchain', () => {
  // These three methods prove a human / an account / a funded address, but NOT
  // that the CALLER controls `user`. Left open, a caller could farm those badges
  // onto an arbitrary wallet (the trust tier gates trial pay + checkout modes).
  // In production they are gated at dispatch under the same fail-closed policy as
  // `dynamic`: require a verified Dynamic session whose wallet IS `user`. `ens`
  // (resolve==user) and `dynamic` (session==user) bind themselves and are exempt.
  beforeEach(() => {
    process.env.BRANDING_REQUIRE_VERIFIED_WRITES = 'true'
  })
  afterEach(() => {
    delete process.env.BRANDING_REQUIRE_VERIFIED_WRITES
  })

  it('401 world-id for an unverified caller — proof never consulted, not recorded', async () => {
    verifyWorldProof.mockResolvedValue({ ok: true, nullifier: 'farm', action: 'ax1-buyer' })
    const res = await POST(post({ user: USER, method: 'world-id', proof: { merkle_root: '0x' } }))
    expect(res.status).toBe(401)
    // The gate runs BEFORE the portal call, so no nullifier is consumed on behalf
    // of an unauthorized caller and nothing is recorded.
    expect(verifyWorldProof).not.toHaveBeenCalled()
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('401 onchain for an unverified caller — chain never read, not recorded', async () => {
    getBalance.mockResolvedValue(10n ** 18n)
    getTransactionCount.mockResolvedValue(5)
    const res = await POST(post({ user: USER, method: 'onchain' }))
    expect(res.status).toBe(401)
    expect(getBalance).not.toHaveBeenCalled()
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('401 oidc for an unverified caller — token never verified, not recorded', async () => {
    const res = await POST(post({ user: USER, method: 'oidc', token: 'x.y.z' }))
    expect(res.status).toBe(401)
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('records world-id when the caller holds a verified session for `user`', async () => {
    vi.mocked(tenant.resolveVerifiedTenant).mockResolvedValueOnce({ tenantId: USER, verified: true })
    verifyWorldProof.mockResolvedValue({ ok: true, nullifier: 'ok', action: 'ax1-buyer' })
    const res = await POST(post({ user: USER, method: 'world-id', proof: { merkle_root: '0x' } }))
    expect(res.status).toBe(200)
    expect((await res.json()).methods).toEqual(['world-id'])
  })
})

describe('tier composition across calls', () => {
  it('climbs Standard -> Verified -> Super Verified as methods compose', async () => {
    verifyWorldProof.mockResolvedValue({ ok: true, nullifier: 'n', action: 'ax1-buyer' })
    resolveENS.mockResolvedValue(USER)
    getBalance.mockResolvedValue(5n)
    getTransactionCount.mockResolvedValue(1)

    let json = await (await POST(post({ user: USER, method: 'world-id', proof: {} }))).json()
    expect(json.tier).toBe('verified')

    json = await (await POST(post({ user: USER, method: 'ens', ensName: 'a.eth' }))).json()
    expect(json.tier).toBe('verified') // World ID + 1 other = still verified

    json = await (await POST(post({ user: USER, method: 'onchain' }))).json()
    expect(json.tier).toBe('super-verified') // World ID + 2 others
    expect(json.methods).toEqual(['world-id', 'ens', 'onchain'])
  })
})
