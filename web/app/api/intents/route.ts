/**
 * POST /api/intents — create a payment intent (P0.3).
 *
 * WHO MAY CREATE: the verified merchant tenant, under exactly the branding
 * store's write policy ({@link resolveVerifiedTenantForWrite}): production
 * requires a verified Dynamic JWT; dev/test may fall back to the body's
 * tenantId when the policy allows. An intent is a merchant asking to be paid
 * — letting anyone mint intents against any merchant would be a phishing
 * factory (mint an intent for a victim-merchant's slug, send the link, the
 * money still settles TO THE MERCHANT on-chain — but the social-engineering
 * surface is not one we hand out).
 *
 * The response is the FULL intent (the creator owns it). The public/customer
 * projection lives on GET /api/intents/[id].
 */
import { NextResponse } from 'next/server'

import {
  TenantAuthError,
  resolveVerifiedTenantForWrite,
} from '@/lib/branding/tenant.js'
import { createIntent } from '@/lib/intents/store.js'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const b = body as Record<string, unknown>

  let tenantId: string
  try {
    // Returns the normalized (wallet-shaped, lowercased) tenant id directly.
    tenantId = await resolveVerifiedTenantForWrite(request, body)
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: 'auth_required', message: err.message }, { status: 401 })
    }
    throw err
  }

  const merchantId = b.merchantId
  const slug = b.slug
  const amountUsd8 = b.amountUsd8
  const chainId = b.chainId
  if (typeof merchantId !== 'number' || !Number.isInteger(merchantId) || merchantId <= 0) {
    return NextResponse.json({ error: 'invalid_merchant_id' }, { status: 400 })
  }
  if (typeof slug !== 'string' || slug.length < 2 || slug.length > 48) {
    return NextResponse.json({ error: 'invalid_slug' }, { status: 400 })
  }
  if (typeof amountUsd8 !== 'number' || typeof chainId !== 'number') {
    return NextResponse.json({ error: 'invalid_amount_or_chain' }, { status: 400 })
  }

  try {
    const intent = createIntent({
      tenantId,
      merchantId,
      slug,
      amountUsd8,
      chainId,
      ...(Array.isArray(b.allowedTokens) ? { allowedTokens: b.allowedTokens as string[] } : {}),
      ...(typeof b.registerId === 'string' ? { registerId: b.registerId } : {}),
      ...(typeof b.note === 'string' ? { note: b.note } : {}),
      ...(typeof b.ttlMs === 'number' ? { ttlMs: b.ttlMs } : {}),
    })
    return NextResponse.json({ intent }, { status: 201 })
  } catch (err) {
    // Store-level bounds violations are client errors; the message names the
    // field without echoing values beyond what the client already sent.
    return NextResponse.json(
      { error: 'invalid_intent', message: err instanceof Error ? err.message : 'rejected' },
      { status: 400 },
    )
  }
}
