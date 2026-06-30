/**
 * POST /api/world/verify — verify an IDKit proof + enforce one-human-per-action
 * (World ID ADR D2 / unit 1, the off-chain default path).
 *
 * The frontend `WorldIdGate` POSTs the RAW IDKit result here. We:
 *   1. forward it AS-IS to the Developer Portal `/api/v4/verify/{rp_id}`
 *      (no field remap — mutation ⇒ verification_failed), via `verifyWorldProof`;
 *   2. on a 200, extract the `nullifier` and CLAIM it under the action with a
 *      UNIQUE(action, nullifier) constraint (`claimNullifier`);
 *   3. a fresh claim → 200 `{ ok: true }` (the checkout unlocks pay);
 *      a repeat → 409 `{ error: 'already_verified' }` (duplicate human).
 *
 * Status map (no secret / stack trace ever in the body — guardrail #7 / law #4):
 *   200 { ok: true, action }              verified + first use → unlock pay
 *   400 { error: 'invalid_json' | 'bad_nullifier' }
 *   401 { error: 'proof_invalid', code } portal rejected the proof
 *   409 { error: 'already_verified' }     this human already cleared this action
 *   502 { error: 'verify_unreachable' }   portal/network unreachable (fail-soft)
 *   503 { error: 'not_configured' }       World ID env not set (pre-booth)
 *
 * This route is verify/gate-only: it NEVER signs, holds, or moves money, and it
 * NEVER leaks a payout address (ADR "Security notes carried forward").
 */

import { NextResponse } from 'next/server'
import { worldAction, worldAgentAction } from '@/lib/worldid/config'
import { verifyWorldProof } from '@/lib/worldid/verify'
import { claimNullifier } from '@/lib/worldid/nullifierStore'
import { unlockAgentTrial } from '@/lib/worldid/agentGate'
import { DurableStoreRequiredError } from '@/lib/security/replayStore'

export const dynamic = 'force-dynamic'

/** The gates this route serves — each maps to a DISTINCT server-config action. */
type WorldGate = 'buyer' | 'agent'

/**
 * Read the OPTIONAL gate selector off the body. This is the only thing the client
 * may say about the action: pick the buyer gate (default) or the agent gate — an
 * enum, never the action string itself. Anything else falls back to the buyer
 * gate, so a body can never widen its own scope (C-2).
 */
function bodyGate(payload: unknown): WorldGate {
  const raw =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).gate
      : undefined
  return raw === 'agent' ? 'agent' : 'buyer'
}

/**
 * Return the IDKit payload with its `action` field FORCED to the server-derived
 * value, so the portal verifies the proof against the SAME action we later claim
 * the nullifier under. Every other proof field is forwarded byte-for-byte (no
 * remap — a mutation of the proof itself ⇒ verification_failed). A body that
 * tried to smuggle an action for a different scope is overwritten here (C-2).
 */
function withServerAction(payload: unknown, action: string): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  return { ...(payload as Record<string, unknown>), action }
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // C-2: the action is the nullifier-store key AND what the portal verifies the
  // proof against — so it MUST come only from trusted server config, never from
  // the request body. The body may only SELECT which configured gate to use (an
  // enum, not a free-form string): the default buyer gate or the agent gate.
  // A body that injects its own `action` cannot present a proof generated for
  // action A under action B — we derive the action server-side and OVERRIDE it
  // in the payload forwarded to the portal so the verified action and the claimed
  // action are always the same trusted value.
  const action =
    bodyGate(payload) === 'agent' ? worldAgentAction() : worldAction()
  const sealedPayload = withServerAction(payload, action)

  const result = await verifyWorldProof(sealedPayload, action)

  if (!result.ok) {
    if (result.code === 'not_configured') {
      return NextResponse.json({ error: 'not_configured' }, { status: 503 })
    }
    if (result.code === 'verify_unreachable') {
      return NextResponse.json({ error: 'verify_unreachable' }, { status: 502 })
    }
    // Any portal rejection (verification_failed, all_verifications_failed, …).
    return NextResponse.json({ error: 'proof_invalid', code: result.code }, { status: 401 })
  }

  // Verified by the portal — now OUR one-per-human enforcement. We claim under the
  // TRUSTED server `action`, never `result.action` (the portal echo), so the
  // nullifier slot can't be steered by anything outside our config (C-2).
  let fresh: boolean
  try {
    fresh = await claimNullifier(action, result.nullifier)
  } catch (err) {
    // FAIL-CLOSED (R-2): no durable replay store in production ⇒ refuse rather
    // than fall back to the replay-vulnerable in-memory set. 503, never a silent pass.
    if (err instanceof DurableStoreRequiredError) {
      return NextResponse.json({ error: 'not_configured' }, { status: 503 })
    }
    // Malformed nullifier field — treat as a bad proof, never a 500.
    return NextResponse.json({ error: 'bad_nullifier' }, { status: 400 })
  }

  if (!fresh) {
    return NextResponse.json({ error: 'already_verified' }, { status: 409 })
  }

  // Track A (ADR D6 / unit 7): when the proof cleared the agent gate (selected by
  // the trusted `gate` enum, not the body action), the agent is now backed by a
  // verified human — unlock its trial allowance. Decided by the server action so a
  // buyer-gate request can never reach the agent gate.
  if (action === worldAgentAction()) {
    unlockAgentTrial()
  }

  return NextResponse.json({ ok: true, action }, { status: 200 })
}
