import { NextResponse } from 'next/server'
import { getBySlug } from '@/lib/branding/store'
import { PUBLIC_BRANDING_CORS, toPublicBranding } from '@/lib/branding/response'

export const dynamic = 'force-dynamic'

/**
 * GET /api/branding/{slug}
 *
 * The PUBLIC, read-only branding lookup the one-tag embed fetches by checkout
 * slug (ADR unit 4 / D4 b). Returns `{ name, description, logoSvg, brandColor,
 * merchantId, router, chainId, onChain }` with permissive CORS so the embed
 * (cross-origin) can read it. NEVER returns a payout address; NEVER accepts a
 * write (only GET/OPTIONS). 404 when the slug is unknown so the embed degrades
 * to its USD-only label rather than rendering a broken brand.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params
  const row = getBySlug(slug)
  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: PUBLIC_BRANDING_CORS })
  }
  return NextResponse.json(toPublicBranding(row), { status: 200, headers: PUBLIC_BRANDING_CORS })
}

/** CORS preflight for the cross-origin embed fetch. */
export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: PUBLIC_BRANDING_CORS })
}
