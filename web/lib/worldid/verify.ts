/**
 * verify.ts — server-only forward of an IDKit proof to the Developer Portal
 * (ADR D2 / unit 1, the off-chain default path).
 *
 * The frontend `WorldIdGate` hands us the RAW IDKit result; we forward it
 * AS-IS to `POST {base}/api/v4/verify/{rp_id}` (NO field remapping — any
 * mutation ⇒ `verification_failed`, per the docs), then extract the `nullifier`
 * and `action` the caller stores. This module does the network + extraction
 * ONLY; the route owns the nullifier dedup + HTTP status mapping, so this stays
 * trivially unit-testable by stubbing `fetch`.
 *
 * It NEVER touches money, a payout address, or a private key — it is a pure
 * verify call (ADR "Security notes carried forward").
 */

import { worldRpId, worldVerifyBase } from './config.js'

/** The shape we pull off a successful Developer-Portal verify response. */
export interface WorldVerifyOk {
  ok: true
  /** The raw nullifier (hex or decimal) the caller stores with UNIQUE(action, nullifier). */
  nullifier: string
  /** The action the proof was scoped to (echoed by the portal). */
  action: string
}

/** A failed verification — a portal rejection or a transport error. */
export interface WorldVerifyErr {
  ok: false
  /** A machine code the route maps to a status (never leaks a secret). */
  code: string
  /** The upstream HTTP status, when the portal responded. */
  status?: number
}

export type WorldVerifyResult = WorldVerifyOk | WorldVerifyErr

/**
 * Pull the nullifier out of a v4 response (`{ nullifier }`) or a legacy v3 one
 * (`{ nullifier }` top-level, or `responses[0].nullifier`). Returns null when no
 * nullifier is present (treated as a failure by the caller).
 */
function extractNullifier(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.nullifier === 'string' && b.nullifier) return b.nullifier
  if (Array.isArray(b.responses) && b.responses.length > 0) {
    const first = b.responses[0] as Record<string, unknown> | undefined
    if (first && typeof first.nullifier === 'string' && first.nullifier) return first.nullifier
  }
  return null
}

/** Pull the action the portal echoes; fall back to the caller-supplied one. */
function extractAction(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const a = (body as Record<string, unknown>).action
    if (typeof a === 'string' && a) return a
  }
  return fallback
}

/**
 * Forward a raw IDKit proof payload to the Developer Portal `/verify/{rp_id}`.
 *
 * @param rawPayload - the IDKit result, forwarded byte-for-byte (no remap).
 * @param expectedAction - the action we asked for; used as the fallback action
 *        and (by the route) as the nullifier-store key.
 * @returns ok + nullifier on a 200; otherwise a coded failure.
 */
export async function verifyWorldProof(
  rawPayload: unknown,
  expectedAction: string,
): Promise<WorldVerifyResult> {
  const rpId = worldRpId()
  if (!rpId) return { ok: false, code: 'not_configured' }

  const url = `${worldVerifyBase()}/api/v4/verify/${encodeURIComponent(rpId)}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Forward AS-IS — no field remapping (docs: mutation ⇒ verification_failed).
      body: JSON.stringify(rawPayload),
    })
  } catch {
    // Network/transport failure — fail-soft, the route returns a plain-English 502.
    return { ok: false, code: 'verify_unreachable' }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const upstream =
      typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).code === 'string'
        ? ((body as Record<string, unknown>).code as string)
        : 'verification_failed'
    return { ok: false, code: upstream, status: res.status }
  }

  // A 200 with success !== true (defensive — the portal signals failure in-body).
  if (typeof body === 'object' && body !== null && (body as Record<string, unknown>).success === false) {
    return { ok: false, code: 'verification_failed', status: res.status }
  }

  const nullifier = extractNullifier(body)
  if (!nullifier) return { ok: false, code: 'no_nullifier', status: res.status }

  return { ok: true, nullifier, action: extractAction(body, expectedAction) }
}
