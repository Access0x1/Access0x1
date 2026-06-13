import { NextResponse } from 'next/server'
import { resolveTenantId, TenantAuthError } from '@/lib/branding/tenant'
import { LogoError, MAX_LOGO_RASTER_BYTES, toInlineSvgLogo } from '@/lib/branding/logo'

export const dynamic = 'force-dynamic'

/**
 * POST /api/branding/logo  — "Add your logo" (ADR unit 3 / D2 step 3).
 *
 * Accepts the merchant's logo as JSON `{ tenantId, logo }` where `logo` is
 * EITHER raw SVG markup OR a base64 `data:image/<png|jpeg|webp|gif>;base64,…`
 * raster. SANITIZES the SVG (strips every script / event handler / remote ref)
 * and converts a raster into an inert inline-SVG `<image>` — the form the Snap's
 * `Image` component requires. Returns `{ logoSvgInline, kind }`; the onboarding
 * screen then sends that string in the Save call.
 *
 * Hard guards: a tenant must be signed in; the payload is size-capped; a
 * scriptful or unsupported logo is a clean 400 (never a stored unsafe asset).
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  try {
    resolveTenantId(body)
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 })
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const logo = (body as { logo?: unknown }).logo
  if (typeof logo !== 'string' || logo.trim().length === 0) {
    return NextResponse.json({ error: 'Add a logo image or SVG.' }, { status: 400 })
  }
  // Coarse pre-check before parsing (the converter enforces the exact cap too).
  if (logo.length > MAX_LOGO_RASTER_BYTES * 2) {
    return NextResponse.json({ error: 'That logo is too large.' }, { status: 413 })
  }

  try {
    const { svg, kind } = toInlineSvgLogo(logo)
    return NextResponse.json({ logoSvgInline: svg, kind }, { status: 200 })
  } catch (err) {
    if (err instanceof LogoError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    return NextResponse.json({ error: 'logo_failed' }, { status: 500 })
  }
}
