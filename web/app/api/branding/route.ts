import { NextResponse } from 'next/server'
import { resolveTenantId, resolveVerifiedTenant, TenantAuthError } from '@/lib/branding/tenant'
import {
  BrandingError,
  getByTenant,
  upsertBranding,
  type TenantBranding,
} from '@/lib/branding/store'
import { DEFAULT_BRAND_COLOR, monogramSvg, normalizeBrandColor } from '@/lib/branding/logo'

export const dynamic = 'force-dynamic'

/**
 * GET /api/branding  (tenant-scoped read for the dashboard / Settings → Branding)
 *
 * Reads the calling tenant's own row so the "edit later" card can prefill. The
 * tenant id comes from the `?tenantId=` query (the same Dynamic identity the
 * write uses). Returns `{ branding: null }` when they have not saved yet.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  let tenantId: string
  try {
    tenantId = resolveTenantId({ tenantId: searchParams.get('tenantId') ?? undefined })
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const row = getByTenant(tenantId)
  return NextResponse.json({ branding: row ? toClientBranding(row) : null })
}

/**
 * POST /api/branding  — the "Save and get my checkout link" action (ADR D2 step 4)
 * AND the Settings → Branding edit. ONE write that:
 *   - resolves the tenant from sign-in,
 *   - sanitizes name + description + brand color (in the store),
 *   - auto-derives a unique checkout slug from the name when none is given,
 *   - auto-generates a monogram logo when none was uploaded (skip-logo default),
 * then returns the persisted row + the checkout slug. No gas, no wallet popup —
 * the row is live immediately; on-chain registration comes later.
 *
 * Body: `{ tenantId, displayName, description?, brandColor?, checkoutSlug?,
 *          logoSvgInline? }`.
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
    // Prefer a server-verified Dynamic JWT (Authorization: Bearer); fall back to
    // the shape-checked body tenantId when no issuer is configured (booth-gated).
    ;({ tenantId } = await resolveVerifiedTenant(request, body))
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 })
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const b = body as Record<string, unknown>
  const displayName = typeof b.displayName === 'string' ? b.displayName : ''
  const description = typeof b.description === 'string' ? b.description : undefined
  const checkoutSlug = typeof b.checkoutSlug === 'string' ? b.checkoutSlug : undefined
  const brandColor = normalizeBrandColor(
    typeof b.brandColor === 'string' ? b.brandColor : DEFAULT_BRAND_COLOR,
  )
  // The logo is the sanitized inline SVG produced by POST /api/branding/logo.
  // When absent, fall back to an auto-monogram so the surface is never broken.
  let logoSvgInline = typeof b.logoSvgInline === 'string' ? b.logoSvgInline : undefined
  if (!logoSvgInline) {
    const existing = getByTenant(tenantId)
    if (existing?.logoSvgInline) {
      logoSvgInline = existing.logoSvgInline
    } else if (displayName.trim()) {
      try {
        logoSvgInline = monogramSvg(displayName, brandColor).svg
      } catch {
        logoSvgInline = undefined // store will keep '' — checkout falls back to text
      }
    }
  }

  try {
    const row = upsertBranding({
      tenantId,
      displayName,
      description,
      brandColor,
      checkoutSlug,
      logoSvgInline,
    })
    return NextResponse.json({ branding: toClientBranding(row) }, { status: 200 })
  } catch (err) {
    if (err instanceof BrandingError) {
      // 409 for a slug collision, 400 for shape errors.
      const status = err.code === 'SLUG_TAKEN' ? 409 : 400
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
}

/**
 * The tenant-facing branding view: the full row MINUS nothing sensitive (the
 * tenant owns it). Distinct from the PUBLIC payout-free payload in response.ts.
 */
function toClientBranding(row: TenantBranding): TenantBranding {
  return row
}
