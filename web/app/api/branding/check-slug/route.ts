import { NextResponse } from 'next/server'
import { isSlugAvailable, isValidSlug, slugify, suggestSlugs } from '@/lib/branding/store'

export const dynamic = 'force-dynamic'

/**
 * GET /api/branding/check-slug?slug=joes-barbershop&tenantId=0x..
 *
 * Powers the live green-check / red-X under the "What is your business called?"
 * field (ADR D2 step 1). Returns `{ available, valid, normalized, suggestions }`.
 * The tenant's OWN current slug counts as available (so editing other fields
 * doesn't flag their existing link as taken). Read-only; no write.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const raw = (searchParams.get('slug') ?? '').trim().toLowerCase()
  const tenantId = searchParams.get('tenantId') ?? undefined

  // Normalize what they typed (the field shows the readable tail; we slugify it).
  const normalized = raw && isValidSlug(raw) ? raw : slugify(raw)
  const valid = isValidSlug(normalized)
  const available = valid && isSlugAvailable(normalized, tenantId)

  return NextResponse.json({
    valid,
    available,
    normalized,
    suggestions: available || !valid ? [] : suggestSlugs(normalized, tenantId),
  })
}
