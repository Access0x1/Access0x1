import { NextResponse } from 'next/server'
import { resolveVerifiedTenantForWrite, TenantAuthError } from '@/lib/branding/tenant'
import { attachOnChain, BrandingError, getByTenant } from '@/lib/branding/store'

export const dynamic = 'force-dynamic'

/**
 * POST /api/branding/attach-onchain — bind an on-chain `merchantId` to the
 * tenant's branding row so their checkout slug becomes PAYABLE ("switch on
 * payments").
 *
 * This is the seam that closes the onboarding loop: branding (name/logo/slug) is
 * saved first via POST /api/branding; once the merchant registers on the Router
 * (RegisterForm → `registerMerchant`), the resulting `merchantId` is attached
 * HERE. Only then does `SlugCheckoutView` resolve a merchant and render the live
 * CheckoutCard instead of the honest "hasn't switched on payments yet" notice.
 *
 * The tenant id is derived the SAME way as the sibling branding writes
 * (`resolveVerifiedTenant`: a server-verified Dynamic JWT when configured, else
 * the shape-checked body `tenantId` — NEVER a free-form client-supplied tenant a
 * caller could spoof). A wallet can therefore only attach to its OWN row.
 *
 * Body: `{ tenantId, merchantId }`.
 *
 *   200 { branding }              attached — the slug is now payable
 *   400 { error: 'no_branding' }  no row yet — set name/logo first
 *   400 { error: 'invalid_merchant_id' }  empty/blank merchantId
 *   400 { error: 'invalid_json' }
 *   401 { error }                 no valid tenant (auth seam)
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  let tenantId: string
  try {
    // Shared write gate (same as POST /api/branding): verified JWT preferred,
    // shape-checked body fallback, and an unverified write fails CLOSED in
    // production. Without this, an unauthenticated POST could repoint a victim's
    // on-chain merchantId — a payment-redirection vector.
    tenantId = await resolveVerifiedTenantForWrite(request, body)
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 })
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const b = body as Record<string, unknown>
  const rawMerchantId = typeof b.merchantId === 'string' ? b.merchantId.trim() : ''
  if (!rawMerchantId) {
    return NextResponse.json({ error: 'invalid_merchant_id' }, { status: 400 })
  }

  // The mode/anchor rides on the branding row; the merchant sets name/logo first.
  // Mirror the no_branding pattern the checkout-mode route uses.
  if (!getByTenant(tenantId)) {
    return NextResponse.json({ error: 'no_branding' }, { status: 400 })
  }

  let row
  try {
    row = attachOnChain(tenantId, { merchantId: rawMerchantId })
  } catch (err) {
    // attachOnChain → upsertBranding re-validates the row and can throw a
    // BrandingError (e.g. CASINO_NEEDS_OPERATOR for an unverified casino tenant, or
    // MERCHANT_TAKEN when the merchantId is already claimed by another tenant).
    // Surface it with its machine code so the UI branches honestly, rather than letting
    // it escape as a bodyless 500 (law #4 — never claim payments are on when the bind
    // never happened). A CONFLICT (merchant id already claimed) is a 409, not a 400.
    if (err instanceof BrandingError) {
      const status = err.code === 'MERCHANT_TAKEN' ? 409 : 400
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }
    return NextResponse.json({ error: 'attach_failed' }, { status: 500 })
  }
  if (!row) {
    // Raced away between the check and the write — treat as no_branding.
    return NextResponse.json({ error: 'no_branding' }, { status: 400 })
  }
  return NextResponse.json({ branding: row }, { status: 200 })
}
