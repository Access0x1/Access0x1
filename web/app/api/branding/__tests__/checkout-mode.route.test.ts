/**
 * @file checkout-mode.route.test.ts — the per-merchant gate save route.
 *
 * POST /api/branding/checkout-mode persists BOTH the identity/privacy choice
 * (checkoutMode) and the Super Verification buyer-tier requirement (requiredTier)
 * onto the same branding row. Pins: tier saves + round-trips; a mode-only save
 * does not reset the tier (requiredTier is optional); no-branding -> 400.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chains', () => ({
  getDefaultChainId: () => 5042002,
  getRouterAddress: () => '0xRouter0000000000000000000000000000000099',
}))

const { POST } = await import('../checkout-mode/route.js')
const store = await import('@/lib/branding/store')

const TENANT = '0x' + 'c'.repeat(40)

function post(body: unknown): Request {
  return new Request('https://x/api/branding/checkout-mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  store.__resetBrandingStore()
  // The merchant must already have a branding row (name/logo set first).
  store.upsertBranding({ tenantId: TENANT, displayName: 'Acme', checkoutSlug: 'acme' })
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/branding/checkout-mode — Super Verification tier', () => {
  it('400 no_branding when the tenant has no row', async () => {
    store.__resetBrandingStore()
    const res = await POST(post({ tenantId: TENANT, requiredTier: 'super-verified' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('no_branding')
  })

  it('saves requiredTier and round-trips it on the row', async () => {
    const res = await POST(post({ tenantId: TENANT, requiredTier: 'super-verified' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.branding.requiredTier).toBe('super-verified')
    expect(store.getByTenant(TENANT)?.requiredTier).toBe('super-verified')
  })

  it('narrows a junk tier to standard (never persists garbage)', async () => {
    const res = await POST(post({ tenantId: TENANT, requiredTier: 'galaxy-brain' }))
    expect((await res.json()).branding.requiredTier).toBe('standard')
  })

  it('a mode-only save does NOT reset a previously-set tier', async () => {
    // First set super-verified...
    await POST(post({ tenantId: TENANT, requiredTier: 'verified' }))
    // ...then save only the checkout mode (no requiredTier in the body).
    const res = await POST(post({ tenantId: TENANT, checkoutMode: 'verified-human' }))
    const body = await res.json()
    expect(body.branding.checkoutMode).toBe('verified-human')
    expect(body.branding.requiredTier).toBe('verified') // preserved
  })

  it('persists both the mode and the tier together', async () => {
    const res = await POST(
      post({ tenantId: TENANT, checkoutMode: 'private', requiredTier: 'verified' }),
    )
    const body = await res.json()
    expect(body.branding.checkoutMode).toBe('private')
    expect(body.branding.requiredTier).toBe('verified')
  })

  it('R1-BYPASS regression: an unverified checkout-mode write fails closed in production', async () => {
    // Flipping a victim's checkout mode/tier gates or reroutes their live
    // checkout (config DoS). This write sibling must share the fail-closed gate.
    process.env.BRANDING_REQUIRE_VERIFIED_WRITES = 'true'
    try {
      const res = await POST(post({ tenantId: TENANT, requiredTier: 'super-verified' }))
      expect(res.status).toBe(401)
      // The victim's mode/tier is untouched (still the default from setup).
      expect(store.getByTenant(TENANT)?.requiredTier ?? null).not.toBe('super-verified')
    } finally {
      delete process.env.BRANDING_REQUIRE_VERIFIED_WRITES
    }
  })
})
