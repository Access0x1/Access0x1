/**
 * branding.route.test.ts — the PUBLIC branding read endpoints (ADR unit 4).
 *
 * `GET /api/branding/{slug}` (embed) + `GET /api/branding/by-merchant/{id}`
 * (Snap). These tests pin the contract the embed + the Snap depend on:
 *   - the exact public payload shape { name, description, logoSvg, brandColor,
 *     merchantId, router, chainId, onChain },
 *   - NO payout address / fee / owner ever leaks (security law),
 *   - CORS is open (`*`) so the cross-origin embed + Origin:null Snap can read,
 *   - 404 for an unknown slug/merchant (embed degrades gracefully),
 *   - 400 for a junk merchant id (never a confusing 500),
 *   - the routes are READ-ONLY (no POST/PUT handler exported).
 *
 * The chains layer is mocked so the router-address resolution is deterministic
 * and offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chains', () => ({
  getDefaultChainId: () => 5042002,
  getRouterAddress: (id: number) => {
    if (id === 5042002) return '0xRouter0000000000000000000000000000000099'
    throw new Error('no router')
  },
}))

const { GET: getBySlugRoute, OPTIONS: optionsSlug } = await import('../[slug]/route.js')
const { GET: getByMerchantRoute } = await import('../by-merchant/[id]/route.js')
const store = await import('@/lib/branding/store')

const TENANT = '0x' + 'a'.repeat(40)

beforeEach(() => {
  store.__resetBrandingStore()
})
afterEach(() => {
  vi.clearAllMocks()
})

function slugParams(slug: string) {
  return { params: Promise.resolve({ slug }) }
}
function idParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe('GET /api/branding/{slug}', () => {
  it('returns the public payload for a known slug', async () => {
    store.upsertBranding({
      tenantId: TENANT,
      displayName: "Joe's Barbershop",
      description: 'Fresh cuts in Brooklyn',
      checkoutSlug: 'joes-barbershop',
      logoSvgInline: '<svg><rect/></svg>',
      brandColor: '#123456',
    })
    const res = await getBySlugRoute(new Request('https://x'), slugParams('joes-barbershop'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      name: "Joe's Barbershop",
      description: 'Fresh cuts in Brooklyn',
      logoSvg: '<svg><rect/></svg>',
      brandColor: '#123456',
      merchantId: null,
      router: '0xRouter0000000000000000000000000000000099',
      chainId: 5042002,
      onChain: false,
      // World ID ADR D0: the public payload now carries the (non-secret,
      // display/gate-only) checkout choice so the checkout knows whether to
      // mount the World ID gate or run the Unlink leg. Defaults for a fresh row.
      checkoutMode: 'standard',
      humanVerifier: 'offchain',
      // Super Verification: the minimum buyer trust tier ('standard' = anyone).
      requiredTier: 'standard',
      // Casino vertical (World prize): default 'standard' for a fresh row.
      vertical: 'standard',
      verifiedOperator: false,
    })
  })

  it('NEVER leaks a payout address / fee / owner', async () => {
    store.upsertBranding({ tenantId: TENANT, displayName: 'Acme', checkoutSlug: 'acme' })
    const res = await getBySlugRoute(new Request('https://x'), slugParams('acme'))
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/payout/i)
    expect(text).not.toMatch(/feeRecipient/i)
    expect(text).not.toMatch(/owner/i)
    expect(text).not.toMatch(/feeBps/i)
  })

  it('sets open CORS + cache headers', async () => {
    store.upsertBranding({ tenantId: TENANT, displayName: 'Acme', checkoutSlug: 'acme' })
    const res = await getBySlugRoute(new Request('https://x'), slugParams('acme'))
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Cache-Control')).toContain('max-age')
  })

  it('404 for an unknown slug (embed degrades gracefully)', async () => {
    const res = await getBySlugRoute(new Request('https://x'), slugParams('nope'))
    expect(res.status).toBe(404)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('onChain=true once a merchant id is attached', async () => {
    store.upsertBranding({ tenantId: TENANT, displayName: 'Acme', checkoutSlug: 'acme' })
    store.attachOnChain(TENANT, { merchantId: '7' })
    const res = await getBySlugRoute(new Request('https://x'), slugParams('acme'))
    const body = await res.json()
    expect(body.merchantId).toBe('7')
    expect(body.onChain).toBe(true)
  })

  it('OPTIONS preflight returns 204 with CORS', () => {
    const res = optionsSlug()
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
  })

  it('is read-only — exports no POST/PUT/DELETE handler', async () => {
    const mod = await import('../[slug]/route.js')
    expect('POST' in mod).toBe(false)
    expect('PUT' in mod).toBe(false)
    expect('DELETE' in mod).toBe(false)
  })
})

describe('GET /api/branding/by-merchant/{id}', () => {
  it('returns the public payload for a known merchant id', async () => {
    store.upsertBranding({ tenantId: TENANT, displayName: 'Acme', checkoutSlug: 'acme' })
    store.attachOnChain(TENANT, { merchantId: '42' })
    const res = await getByMerchantRoute(new Request('https://x'), idParams('42'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('Acme')
    expect(body.merchantId).toBe('42')
    expect(body.router).toBe('0xRouter0000000000000000000000000000000099')
  })

  it('400 for a junk merchant id (never a confusing 500)', async () => {
    const res = await getByMerchantRoute(new Request('https://x'), idParams('abc'))
    expect(res.status).toBe(400)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('404 for an unknown merchant id (Snap falls back to nameHash)', async () => {
    const res = await getByMerchantRoute(new Request('https://x'), idParams('999'))
    expect(res.status).toBe(404)
  })
})
