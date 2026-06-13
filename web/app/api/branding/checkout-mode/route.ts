import { NextResponse } from 'next/server'
import { resolveTenantId, TenantAuthError } from '@/lib/branding/tenant'
import {
  asCheckoutMode,
  asHumanVerifier,
  BrandingError,
  getByTenant,
  upsertBranding,
} from '@/lib/branding/store'

export const dynamic = 'force-dynamic'

/**
 * POST /api/branding/checkout-mode — save the D0 "Who can pay you?" choice
 * (World ID ADR D0 / unit 3).
 *
 * The plain-English toggle (verified-human | private | standard) + the
 * verified-human verifier sub-choice (offchain | onchain) live on the SAME
 * `tenant_branding` row branding uses (the white-label store). This route
 * updates ONLY those fields: it reads the tenant's existing display name and
 * re-upserts, so a merchant can change "who can pay" without re-entering their
 * name/logo. It composes with the branding seam — it does not duplicate it.
 *
 * Body: `{ tenantId, checkoutMode, humanVerifier? }`.
 *
 *   200 { branding }              saved
 *   400 { error: 'no_branding' }  no row yet — set name/logo first (front-end gates this)
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
    tenantId = resolveTenantId(body)
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 })
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const b = body as Record<string, unknown>
  const checkoutMode = asCheckoutMode(b.checkoutMode)
  const humanVerifier = asHumanVerifier(b.humanVerifier)

  const existing = getByTenant(tenantId)
  if (!existing) {
    // The mode rides on the branding row; the merchant sets name/logo first.
    return NextResponse.json({ error: 'no_branding' }, { status: 400 })
  }

  try {
    const row = upsertBranding({
      tenantId,
      displayName: existing.displayName,
      checkoutMode,
      humanVerifier,
    })
    return NextResponse.json({ branding: row }, { status: 200 })
  } catch (err) {
    if (err instanceof BrandingError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
}
