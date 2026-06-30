/**
 * @file attachOnChain.route.test.ts — the "switch on payments" bind route.
 *
 * POST /api/branding/attach-onchain binds an on-chain `merchantId` to the
 * tenant's branding row, making the checkout slug PAYABLE. This is the seam that
 * closes the onboarding loop (branding saved → register on-chain → slug live).
 *
 * Pins:
 *   - success: a valid merchantId attaches and the row reports it,
 *   - no_branding: a tenant with no row → 400 no_branding (mirrors checkout-mode),
 *   - bad input: blank/missing merchantId → 400 invalid_merchant_id,
 *   - tenant-isolation: the resolved tenant comes from the auth seam, so a wallet
 *     can only attach to ITS OWN row (a body tenantId for someone else's row is
 *     the only identity in the booth-gated fallback, and it never touches another
 *     tenant's row).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chains', () => ({
  getDefaultChainId: () => 5042002,
  getRouterAddress: () => '0xRouter0000000000000000000000000000000099',
}))

const { POST } = await import('../attach-onchain/route.js')
const store = await import('@/lib/branding/store')

const TENANT_A = '0x' + 'a'.repeat(40)
const TENANT_B = '0x' + 'b'.repeat(40)

function post(body: unknown): Request {
  return new Request('https://x/api/branding/attach-onchain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  store.__resetBrandingStore()
  // Tenant A has a branding row (name/logo/slug saved first).
  store.upsertBranding({ tenantId: TENANT_A, displayName: 'Acme', checkoutSlug: 'acme' })
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/branding/attach-onchain', () => {
  it('attaches a valid merchantId and makes the slug payable', async () => {
    expect(store.getByTenant(TENANT_A)?.merchantId).toBeNull()
    const res = await POST(post({ tenantId: TENANT_A, merchantId: '42' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.branding.merchantId).toBe('42')
    // The store is now reverse-indexed by merchantId (the by-merchant lookup).
    expect(store.getByTenant(TENANT_A)?.merchantId).toBe('42')
    expect(store.getByMerchantId('42')?.tenantId).toBe(TENANT_A)
  })

  it('400 no_branding when the tenant has no row', async () => {
    const res = await POST(post({ tenantId: TENANT_B, merchantId: '42' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('no_branding')
  })

  it('400 invalid_merchant_id on a blank merchantId', async () => {
    const res = await POST(post({ tenantId: TENANT_A, merchantId: '   ' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_merchant_id')
  })

  it('400 invalid_merchant_id when merchantId is missing', async () => {
    const res = await POST(post({ tenantId: TENANT_A }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_merchant_id')
  })

  it('401 on a junk (non-wallet) tenant id', async () => {
    const res = await POST(post({ tenantId: 'not-a-wallet', merchantId: '42' }))
    expect(res.status).toBe(401)
  })

  it('400 invalid_json on a non-JSON body', async () => {
    const res = await POST(
      new Request('https://x/api/branding/attach-onchain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_json')
  })

  it('tenant-isolation: attaching as tenant B never touches tenant A’s row', async () => {
    // Tenant B has no row; tenant A does. A booth-gated request that asserts
    // tenant B can only ever bind tenant B's (nonexistent) row → no_branding,
    // and tenant A's row is left untouched (no merchantId leaked across tenants).
    const res = await POST(post({ tenantId: TENANT_B, merchantId: '99' }))
    expect(res.status).toBe(400)
    expect(store.getByTenant(TENANT_A)?.merchantId).toBeNull()
    expect(store.getByMerchantId('99')).toBeNull()
  })
})
