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

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // The action we asked for in the widget — the nullifier-store key. Allow the
  // body to carry an explicit action (operator badge / agent gate reuse the same
  // route with their own action), defaulting to the buyer-gate action.
  const bodyAction =
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>).action === 'string'
      ? ((payload as Record<string, unknown>).action as string)
      : worldAction()

  const result = await verifyWorldProof(payload, bodyAction)

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

  // Verified by the portal — now OUR one-per-human enforcement.
  let fresh: boolean
  try {
    fresh = claimNullifier(result.action, result.nullifier)
  } catch {
    // Malformed nullifier field — treat as a bad proof, never a 500.
    return NextResponse.json({ error: 'bad_nullifier' }, { status: 400 })
  }

  if (!fresh) {
    return NextResponse.json({ error: 'already_verified' }, { status: 409 })
  }

  // Track A (ADR D6 / unit 7): if this proof was for the agent action, the agent
  // is now backed by a verified human — unlock its trial allowance. Buyer/operator
  // actions don't touch the agent gate (distinct action strings, separate slots).
  if (result.action === worldAgentAction()) {
    unlockAgentTrial()
  }

  return NextResponse.json({ ok: true, action: result.action }, { status: 200 })
}
