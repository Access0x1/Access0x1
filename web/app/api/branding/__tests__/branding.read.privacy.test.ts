/**
 * @file branding.read.privacy.test.ts — GET /api/branding must not leak verification fields (R-8).
 *
 * The tenant-scoped read is keyed on an UNAUTHENTICATED `?tenantId=` query (anyone can pass any
 * wallet address). It therefore must NOT return the verification fields — `operatorNullifier`
 * (a World ID nullifier hash), `humanVerifier`, and `requiredTier` — to an unauthenticated caller,
 * which would be a privacy / tenant-enumeration regression for a personhood product.
 *
 * These pin the split projection:
 *   - an unauthenticated read (no Bearer token / no issuer configured) STRIPS the three fields,
 *   - the non-sensitive fields (displayName, brandColor, slug, …) still come back so the
 *     dashboard prefill keeps working,
 *   - a junk / missing tenant id is still a clean 401,
 *   - a not-yet-saved tenant returns { branding: null }.
 *
 * The verified-owner full-row path needs a live Dynamic JWKS to verify a JWT, so it is exercised
 * by the tenant-resolver unit tests (lib/branding/__tests__) rather than re-mocked here; this file
 * pins the security-critical default (unauthenticated ⇒ stripped).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chains', () => ({
  getDefaultChainId: () => 5042002,
  getRouterAddress: () => '0xRouter0000000000000000000000000000000099',
}))

const { GET } = await import('../route.js')
const store = await import('@/lib/branding/store')

const TENANT = '0x' + 'c'.repeat(40)
const NULLIFIER = '12345678901234567890' // a World ID nullifier (decimal) — must never leak

beforeEach(() => {
  store.__resetBrandingStore()
  // No issuer configured ⇒ resolveVerifiedTenant returns verified:false ⇒ public projection.
  delete process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID
})
afterEach(() => {
  vi.clearAllMocks()
})

function get(tenantId?: string): Request {
  const url = tenantId
    ? `https://x/api/branding?tenantId=${tenantId}`
    : 'https://x/api/branding'
  return new Request(url)
}

describe('GET /api/branding — unauthenticated projection (R-8)', () => {
  it('strips operatorNullifier / humanVerifier / requiredTier for an unauthenticated caller', async () => {
    store.upsertBranding({
      tenantId: TENANT,
      displayName: 'Acme Casino',
      checkoutSlug: 'acme-casino',
      verifiedOperator: true,
      operatorNullifier: NULLIFIER,
      humanVerifier: 'onchain',
      requiredTier: 'verified',
    })

    const res = await GET(get(TENANT))
    expect(res.status).toBe(200)
    const { branding } = await res.json()

    // The three verification fields are absent from the wire entirely (not just null).
    expect('operatorNullifier' in branding).toBe(false)
    expect('humanVerifier' in branding).toBe(false)
    expect('requiredTier' in branding).toBe(false)

    // And the nullifier value never appears anywhere in the serialized response.
    const text = JSON.stringify(branding)
    expect(text).not.toContain(NULLIFIER)
  })

  it('still returns the non-sensitive fields so the dashboard prefill works', async () => {
    store.upsertBranding({
      tenantId: TENANT,
      displayName: 'Acme Casino',
      checkoutSlug: 'acme-casino',
      brandColor: '#123456',
      operatorNullifier: NULLIFIER,
    })

    const res = await GET(get(TENANT))
    const { branding } = await res.json()
    expect(branding.displayName).toBe('Acme Casino')
    expect(branding.checkoutSlug).toBe('acme-casino')
    expect(branding.brandColor).toBe('#123456')
    expect(branding.tenantId).toBe(TENANT)
  })

  it('401 for a junk tenant id (never a confusing 200/500)', async () => {
    const res = await GET(get('not-an-address'))
    expect(res.status).toBe(401)
  })

  it('401 with no tenant id at all', async () => {
    const res = await GET(get())
    expect(res.status).toBe(401)
  })

  it('returns { branding: null } for a not-yet-saved tenant', async () => {
    const res = await GET(get(TENANT))
    expect(res.status).toBe(200)
    const { branding } = await res.json()
    expect(branding).toBeNull()
  })
})
