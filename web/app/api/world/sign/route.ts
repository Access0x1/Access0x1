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
 *
 * THE ACTION IS PUBLISHED, NOT GUESSED. A proof is bound to `hash(app_id,
 * action)`, so the action this route SIGNS and the action the widget generates
 * the proof against must be the same string. The widget cannot read the
 * server-only `WORLD_ACTION` family (Next inlines only `NEXT_PUBLIC_*`), so it
 * used to fall back to the baked default while the server used the configured
 * value — a custom action string silently produced a 401 `proof_invalid` with
 * nothing in the response naming the cause. This route now returns `action`
 * (and the `gate` it belongs to) next to the `rp_context`, and the widget uses
 * that value verbatim. Server and client can no longer disagree.
 *
 * The caller selects a gate with `?gate=buyer|operator|agent|agentkit` — a NAMED
 * enum resolved by `worldGateAction()`, never a caller-supplied action string, so
 * a request can never have a context signed for a scope it invented. Signing is
 * not authorization: the RP context only lets a widget open; every gate's own
 * verify route still applies its own auth and claims its own nullifier.
 */

import { NextResponse } from 'next/server'
import { signRequest } from '@worldcoin/idkit/signing'
import {
  asWorldGate,
  worldGateAction,
  worldRpId,
  worldSigningKey,
  type WorldGate,
} from '@/lib/worldid/config'

export const dynamic = 'force-dynamic'

/** A v4 RpContext, exactly what `IDKitRequestWidget`'s `rp_context` prop wants. */
interface RpContextResponse {
  rp_id: string
  nonce: string
  created_at: number
  expires_at: number
  signature: string
}

/**
 * What this route returns: the v4 RP context PLUS the action it was signed for.
 * `action` and `gate` are non-secret by design — the action string is already
 * public in the widget and in `hash(app_id, action)`.
 */
export interface SignResponse extends RpContextResponse {
  /** The server-configured action this context was signed for. Authoritative. */
  action: string
  /** The named gate that action belongs to (echo of the resolved `?gate=`). */
  gate: WorldGate
}

export async function GET(request: Request): Promise<NextResponse> {
  const rpId = worldRpId()
  const key = worldSigningKey() // server-only; throws if read client-side

  if (!rpId || !key) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 })
  }

  // The client names a GATE; the server alone maps it to an action string.
  const gate = asWorldGate(new URL(request.url).searchParams.get('gate'))
  const action = worldGateAction(gate)

  try {
    const sig = signRequest({ signingKeyHex: key, action })
    const ctx: SignResponse = {
      rp_id: rpId,
      nonce: sig.nonce,
      created_at: sig.createdAt,
      expires_at: sig.expiresAt,
      signature: sig.sig,
      action,
      gate,
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
