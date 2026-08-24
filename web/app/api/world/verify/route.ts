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
 *   400 { error: 'invalid_json' | 'bad_nullifier' | 'unsupported_gate' }
 *   401 { error: 'proof_invalid', code } portal rejected the proof
 *   409 { error: 'already_verified' }     this human already cleared this action
 *   502 { error: 'verify_unreachable' }   portal/network unreachable (fail-soft)
 *   503 { error: 'not_configured' }       World ID env not set (pre-booth)
 *
 * This route is verify/gate-only: it NEVER signs, holds, or moves money, and it
 * NEVER leaks a payout address (ADR "Security notes carried forward").
 */

import { NextResponse } from 'next/server'
import { isWorldGate, worldGateAction, type WorldGate } from '@/lib/worldid/config'
import { verifyWorldProof } from '@/lib/worldid/verify'
import { claimNullifier } from '@/lib/worldid/nullifierStore'
import { unlockAgentTrial } from '@/lib/worldid/agentGate'
import { DurableStoreRequiredError } from '@/lib/security/replayStore'

export const dynamic = 'force-dynamic'

/**
 * The gates THIS route serves. A strict subset of the shared {@link WorldGate}
 * enum: `operator` has its own verify route (`/api/branding/operator-verify`,
 * which also awards the badge) and `agentkit` is driven by
 * `lib/worldid/agentkit.ts`, so serving either here would claim their
 * one-per-human nullifier without doing their work.
 */
const SERVED_GATES: readonly WorldGate[] = ['buyer', 'agent']

/**
 * Read the OPTIONAL gate selector off the body and resolve it to a gate this
 * route actually serves. An enum, never the action string itself — a body can
 * never widen its own scope (C-2).
 *
 * WHY THIS REFUSES INSTEAD OF DEFAULTING. Silently narrowing an unserved gate to
 * `buyer` was the shape of the bug this route used to have on the sign side: the
 * proof in hand is bound to `hash(app_id, action)` for the gate the client asked
 * `/api/world/sign` to sign, so re-reading it under the buyer action makes the
 * Developer Portal reject it and the caller sees a bare 401 `proof_invalid` with
 * nothing naming the cause. A `<WorldIdGate gate="agentkit" />` pointed at this
 * route's default `verifyUrl` reproduces exactly that. It fails CLOSED either
 * way — no proof for another scope can ever be laundered into a buyer claim —
 * so this is a diagnosability fix, not a hole being plugged, and a named 400
 * beats a mystery 401.
 *
 * @param payload - the parsed request body (untrusted).
 * @returns the served gate, or `null` when the body named a gate this route
 *          does not serve (including an unrecognised name). An ABSENT `gate`
 *          field stays the buyer gate, so every existing caller is unchanged.
 */
function bodyGate(payload: unknown): WorldGate | null {
  const raw =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).gate
      : undefined
  if (raw === undefined || raw === null) return 'buyer'
  return isWorldGate(raw) && SERVED_GATES.includes(raw) ? raw : null
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
  // enum, not an arbitrary string): the default buyer gate or the agent gate.
  // A body that injects its own `action` cannot present a proof generated for
  // action A under action B — we derive the action server-side and OVERRIDE it
  // in the payload forwarded to the portal so the verified action and the claimed
  // action are always the same trusted value.
  const gate = bodyGate(payload)
  if (gate === null) {
    // Named a real gate this route does not serve, or invented one. Refuse by name
    // rather than downgrade — see `bodyGate`. No secret, no stack trace (law #4).
    return NextResponse.json({ error: 'unsupported_gate' }, { status: 400 })
  }

  const action = worldGateAction(gate)
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
  // verified human — unlock its trial allowance.
  //
  // Keyed on the GATE, never on the resolved action string. A deployment that
  // sets WORLD_ACTION and WORLD_AGENT_ACTION to the same value would otherwise
  // have every buyer verify silently unlock the agent trial; the gate enum cannot
  // collide that way, and it is already the trusted server-side selection.
  if (gate === 'agent') {
    unlockAgentTrial()
  }

  return NextResponse.json({ ok: true, action }, { status: 200 })
}
