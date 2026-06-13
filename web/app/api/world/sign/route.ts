/**
 * GET /api/world/sign — mint the RP context the IDKit widget needs (World ID
 * ADR D2 / unit 1).
 *
 * RP (relying-party) signatures are REQUIRED for World ID 4.0 and MUST be
 * generated server-side (docs §4). This route reads the SERVER-ONLY
 * `WORLD_SIGNING_KEY` (via `worldSigningKey()`, which throws if ever read in a
 * browser) and signs a fresh request. It NEVER returns the signing key — only
 * the public `rp_context` ({ rp_id, nonce, created_at, expires_at, signature }).
 *
 * The IDKit-server `signRequest({ signingKeyHex, action })` returns camelCase
 * `{ sig, nonce, createdAt, expiresAt }`; we assemble that into the v4
 * `RpContext` shape the widget expects (add `rp_id`, rename to snake_case +
 * `signature`). This is RP-CONTEXT assembly, NOT proof-payload mutation — the
 * proof itself is forwarded as-is by the verify route.
 *
 * Fail-soft: when the key/app/rp env is unset (pre-booth), this returns a clean
 * 503 `{ error: 'not_configured' }` so the client treats World ID as
 * unavailable rather than crashing (ADR D7).
 */

import { NextResponse } from 'next/server'
import { signRequest } from '@worldcoin/idkit/signing'
import { worldAction, worldRpId, worldSigningKey } from '@/lib/worldid/config'

export const dynamic = 'force-dynamic'

/** A v4 RpContext, exactly what `IDKitRequestWidget`'s `rp_context` prop wants. */
interface RpContextResponse {
  rp_id: string
  nonce: string
  created_at: number
  expires_at: number
  signature: string
}

export async function GET(): Promise<NextResponse> {
  const rpId = worldRpId()
  const key = worldSigningKey() // server-only; throws if read client-side

  if (!rpId || !key) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 })
  }

  try {
    const sig = signRequest({ signingKeyHex: key, action: worldAction() })
    const ctx: RpContextResponse = {
      rp_id: rpId,
      nonce: sig.nonce,
      created_at: sig.createdAt,
      expires_at: sig.expiresAt,
      signature: sig.sig,
    }
    // Never cache an RP context — each is single-use with a 5-min TTL.
    return NextResponse.json(ctx, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch {
    // Never leak the key or a stack trace in the body (secrets law / guardrail #7).
    return NextResponse.json({ error: 'sign_failed' }, { status: 500 })
  }
}
