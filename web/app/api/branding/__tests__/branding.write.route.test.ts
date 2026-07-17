/**
 * branding.write.route.test.ts — the tenant-scoped WRITE routes (ADR unit 2/3).
 *
 * POST /api/branding (Save), POST /api/branding/logo (sanitize+convert),
 * GET /api/branding/check-slug (live availability). Pins:
 *   - a write with no valid tenant id is 401 (the auth seam),
 *   - Save auto-monograms when no logo is supplied (skip-logo default),
 *   - Save returns the checkout slug + sanitizes the description,
 *   - a slug collision with another tenant is 409,
 *   - the logo route rejects a scriptful SVG with a clean 400 (no unsafe store),
 *   - check-slug reports availability + suggestions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chains', () => ({
  getDefaultChainId: () => 5042002,
  getRouterAddress: () => '0xRouter0000000000000000000000000000000099',
}))

const { POST: saveRoute, GET: readRoute } = await import('../route.js')
const { POST: logoRoute } = await import('../logo/route.js')
const { GET: checkSlugRoute } = await import('../check-slug/route.js')
const store = await import('@/lib/branding/store')

const TENANT_A = '0x' + 'a'.repeat(40)
const TENANT_B = '0x' + 'b'.repeat(40)

function postJson(handler: (r: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handler(
    new Request('https://x/api/branding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  store.__resetBrandingStore()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/branding (Save)', () => {
  it('401 when no valid tenant id (auth seam)', async () => {
    const res = await postJson(saveRoute, { displayName: 'Acme' })
    expect(res.status).toBe(401)
  })

  it('401 when tenantId is not a wallet address', async () => {
    const res = await postJson(saveRoute, { tenantId: 'not-an-address', displayName: 'Acme' })
    expect(res.status).toBe(401)
  })

  it('rejects an UNVERIFIED write with 401 when verified writes are required (prod fail-closed)', async () => {
    // No Dynamic issuer is configured in the test env, so resolveVerifiedTenant
    // returns verified:false (the booth-gated fallback). With the policy flag on
    // — the production posture — that unverified write must be rejected, so an
    // attacker can't overwrite an arbitrary tenant's branding by shape alone.
    process.env.BRANDING_REQUIRE_VERIFIED_WRITES = 'true'
    try {
      const res = await postJson(saveRoute, { tenantId: TENANT_A, displayName: 'Acme' })
      expect(res.status).toBe(401)
      // And nothing was persisted for that tenant.
      expect(store.getByTenant(TENANT_A)).toBeNull()
    } finally {
      delete process.env.BRANDING_REQUIRE_VERIFIED_WRITES
    }
  })

  it('still accepts the booth-gated fallback write when verification is NOT required (dev/demo)', async () => {
    // Default test posture (flag unset, non-production): the fallback stands so
    // the onboarding flow works before Dynamic is wired.
    delete process.env.BRANDING_REQUIRE_VERIFIED_WRITES
    const res = await postJson(saveRoute, { tenantId: TENANT_A, displayName: 'Acme' })
    expect(res.status).toBe(200)
  })

  it('saves with an auto-monogram when no logo is supplied (skip-logo default)', async () => {
    const res = await postJson(saveRoute, { tenantId: TENANT_A, displayName: "Joe's Barbershop" })
    expect(res.status).toBe(200)
    const { branding } = await res.json()
    expect(branding.checkoutSlug).toBe('joe-s-barbershop')
    expect(branding.logoSvgInline).toContain('<svg')
    expect(branding.logoSvgInline).toContain('>JB<') // monogram initials
  })

  it('sanitizes the description (no markup reaches the store)', async () => {
    const res = await postJson(saveRoute, {
      tenantId: TENANT_A,
      displayName: 'Acme',
      description: '<b>Best</b> cuts',
    })
    const { branding } = await res.json()
    expect(branding.description).toBe('Best cuts')
  })

  it('409 on a slug collision with another tenant', async () => {
    await postJson(saveRoute, { tenantId: TENANT_A, displayName: 'Acme', checkoutSlug: 'acme' })
    const res = await postJson(saveRoute, {
      tenantId: TENANT_B,
      displayName: 'Other',
      checkoutSlug: 'acme',
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('SLUG_TAKEN')
  })

  it('GET reflects the saved row for the tenant', async () => {
    await postJson(saveRoute, { tenantId: TENANT_A, displayName: 'Acme' })
    const res = await readRoute(new Request(`https://x/api/branding?tenantId=${TENANT_A}`))
    const { branding } = await res.json()
    expect(branding.displayName).toBe('Acme')
  })

  it('GET 401 with no tenant id', async () => {
    const res = await readRoute(new Request('https://x/api/branding'))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/branding/logo', () => {
  it('401 with no tenant', async () => {
    const res = await postJson(logoRoute, { logo: '<svg><rect/></svg>' })
    expect(res.status).toBe(401)
  })

  it('sanitizes a scriptful SVG to a clean inline SVG', async () => {
    const res = await postJson(logoRoute, {
      tenantId: TENANT_A,
      logo: '<svg onload="evil()"><script>x</script><rect/></svg>',
    })
    expect(res.status).toBe(200)
    const { logoSvgInline } = await res.json()
    expect(logoSvgInline).not.toMatch(/<script/i)
    expect(logoSvgInline).not.toMatch(/onload/i)
  })

  it('400 for a non-image / unsupported logo', async () => {
    const res = await postJson(logoRoute, { tenantId: TENANT_A, logo: 'just text' })
    expect(res.status).toBe(400)
  })

  it('wraps a raster data-uri', async () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const res = await postJson(logoRoute, { tenantId: TENANT_A, logo: PNG })
    expect(res.status).toBe(200)
    const { logoSvgInline, kind } = await res.json()
    expect(kind).toBe('raster')
    expect(logoSvgInline).toContain('<image')
  })
})

describe('GET /api/branding/check-slug', () => {
  it('reports a free slug available', async () => {
    const res = await checkSlugRoute(
      new Request('https://x/api/branding/check-slug?slug=joes-barbershop'),
    )
    const body = await res.json()
    expect(body.valid).toBe(true)
    expect(body.available).toBe(true)
  })

  it('reports a taken slug unavailable with suggestions', async () => {
    store.upsertBranding({ tenantId: TENANT_A, displayName: 'Acme', checkoutSlug: 'acme' })
    const res = await checkSlugRoute(new Request('https://x/api/branding/check-slug?slug=acme'))
    const body = await res.json()
    expect(body.available).toBe(false)
    expect(body.suggestions.length).toBeGreaterThan(0)
  })

  it('normalizes a messy input into a slug', async () => {
    const res = await checkSlugRoute(
      new Request(`https://x/api/branding/check-slug?slug=${encodeURIComponent("Joe's Shop!")}`),
    )
    const body = await res.json()
    expect(body.normalized).toBe('joe-s-shop')
  })
})
