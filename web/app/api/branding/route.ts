import { NextResponse } from 'next/server'
import {
  resolveTenantId,
  resolveVerifiedTenant,
  resolveVerifiedTenantForWrite,
  TenantAuthError,
} from '@/lib/branding/tenant'
import {
  BrandingError,
  getByTenant,
  upsertBranding,
  type TenantBranding,
} from '@/lib/branding/store'
import { DEFAULT_BRAND_COLOR, monogramSvg, normalizeBrandColor } from '@/lib/branding/logo'
import { issueMerchantSubname } from '@/lib/ens-subnames'

export const dynamic = 'force-dynamic'

/**
 * Best-effort ENS subname on onboarding (WRITE seam). Fires AFTER the save so it
 * can NEVER block or fail the branding write — the seam is itself fail-soft (a
 * clean no-op when `NAMESTONE_API_KEY` / `ENS_SUBNAME_PARENT` are unset), and we
 * additionally swallow any error here. Off the money path, purely additive: a
 * merchant who gets no subname still has a fully working checkout.
 *
 * The label id prefers the on-chain merchant id; until the tenant registers
 * on-chain it falls back to the checkout slug so the name is stable + readable.
 * The owner is the tenant's wallet (the tenant id IS the 0x address).
 */
function issueSubnameInBackground(row: TenantBranding): void {
  const id = row.merchantId ?? row.checkoutSlug
  if (!id) return
  void issueMerchantSubname({ id, owner: row.tenantId }).catch(() => {
    // Swallow: additive seam, never surfaced to the merchant's save flow.
  })
}

/**
 * GET /api/branding  (tenant-scoped read for the dashboard / Settings → Branding)
 *
 * Reads the calling tenant's own row so the "edit later" card can prefill. The
 * tenant id comes from the `?tenantId=` query (the same Dynamic identity the
 * write uses). Returns `{ branding: null }` when they have not saved yet.
 *
 * R-8: the `?tenantId=` query is UNAUTHENTICATED — anyone can pass any wallet
 * address — so this endpoint MUST NOT leak the verification fields
 * (`operatorNullifier` — a World ID nullifier hash — `humanVerifier`,
 * `requiredTier`) to an unauthenticated caller (a privacy/enumeration regression
 * for a personhood product). We therefore split the projection: a caller who
 * proves ownership via a verified Dynamic JWT (`Authorization: Bearer`) for the
 * SAME tenant gets the full row; everyone else gets the public projection with
 * the verification fields stripped.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const queryTenantId = searchParams.get('tenantId') ?? undefined

  // Always shape-check the query tenant id (so a junk address is a clean 401).
  let tenantId: string
  try {
    tenantId = resolveTenantId({ tenantId: queryTenantId })
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Was a verified Dynamic JWT presented for THIS tenant? Only then do we return
  // the verification fields. A presented-but-invalid token, a mismatched wallet,
  // or no token all resolve to the stripped public projection (never a 500/leak).
  let verifiedOwner = false
  try {
    const resolved = await resolveVerifiedTenant(request, { tenantId })
    verifiedOwner = resolved.verified && resolved.tenantId === tenantId
  } catch {
    verifiedOwner = false
  }

  const row = getByTenant(tenantId)
  if (!row) return NextResponse.json({ branding: null })
  return NextResponse.json({
    branding: verifiedOwner ? toClientBranding(row) : toUnauthenticatedBranding(row),
  })
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
    // Shared write gate: verified Dynamic JWT preferred, shape-checked body
    // fallback — and in production (fail-closed) an unverified write is rejected
    // so it can't overwrite another tenant's branding. Every branding WRITE
    // route goes through this one helper (reads stay open via the GET path).
    tenantId = await resolveVerifiedTenantForWrite(request, body)
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
    // Best-effort gasless ENS subname for the merchant (WRITE seam). Fire-and-
    // forget AFTER the save so it can never block or fail the branding write;
    // a clean no-op when the seam is unconfigured. Off the money path.
    issueSubnameInBackground(row)
    return NextResponse.json({ branding: toClientBranding(row) }, { status: 200 })
  } catch (err) {
    if (err instanceof BrandingError) {
      // 409 for a slug / merchant-id collision, 400 for shape errors.
      const status = err.code === 'SLUG_TAKEN' || err.code === 'MERCHANT_TAKEN' ? 409 : 400
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
}

/**
 * The tenant-facing branding view: the full row, returned ONLY to a caller that
 * proved ownership via a verified Dynamic JWT (the tenant owns it). Distinct from
 * the PUBLIC payout-free payload in response.ts.
 */
function toClientBranding(row: TenantBranding): TenantBranding {
  return row
}

/** The tenant-row projection with the verification fields removed (R-8). */
type UnauthenticatedBranding = Omit<
  TenantBranding,
  'operatorNullifier' | 'humanVerifier' | 'requiredTier'
>

/**
 * The unauthenticated projection (R-8): the full tenant row MINUS the
 * verification fields — `operatorNullifier` (a World ID nullifier hash),
 * `humanVerifier`, and `requiredTier`. The `?tenantId=` query is
 * unauthenticated, so this is what a caller who has NOT proven ownership of the
 * tenant receives. The fields are removed via destructuring (not nulled) so they
 * never appear on the wire at all.
 *
 * NOTE: distinct from `lib/branding/response.ts`'s `toPublicBranding`, which is
 * the reshaped embed/Snap payload (name/logoSvg/router/…). This one keeps the raw
 * tenant-row field names the dashboard prefill expects.
 */
function toUnauthenticatedBranding(row: TenantBranding): UnauthenticatedBranding {
  const { operatorNullifier: _n, humanVerifier: _h, requiredTier: _t, ...publicRow } = row
  return publicRow
}
