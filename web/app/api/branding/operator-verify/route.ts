import { NextResponse } from 'next/server'
import { resolveVerifiedTenant, TenantAuthError } from '@/lib/branding/tenant'
import { BrandingError, getByTenant, upsertBranding } from '@/lib/branding/store'
import { worldOperatorAction } from '@/lib/worldid/config'
import { verifyWorldProof } from '@/lib/worldid/verify'
import { claimNullifier } from '@/lib/worldid/nullifierStore'

export const dynamic = 'force-dynamic'

/**
 * POST /api/branding/operator-verify — the operator proves they are a real,
 * unique human with World ID, and we record it on their branding row (Casino
 * vertical, World prize; reuses the ADR D1.4 operator badge seam).
 *
 * This is the load-bearing step for a casino: `upsertBranding` BLOCKS saving a
 * casino until `verifiedOperator === true`, and this route is the ONLY way that
 * flag is set. It scopes the proof to the DISTINCT `worldOperatorAction()` so an
 * operator's one-per-human slot never collides with the buyer gate or the agent
 * trial.
 *
 * Flow (mirrors /api/world/verify, then writes the row):
 *   1. resolve the tenant (Dynamic JWT preferred; body fallback when unconfigured),
 *   2. forward the RAW IDKit proof to the portal under the operator action,
 *   3. claim the operator nullifier (one human per operator action),
 *   4. on a fresh claim, set verifiedOperator=true + operatorNullifier on the row.
 *
 * Status map (no secret / stack trace ever in the body — law #4):
 *   200 { branding }                 verified → operator badge recorded
 *   400 { error: 'invalid_json' | 'bad_nullifier' | 'no_branding' }
 *   401 { error }                    no valid tenant / portal rejected the proof
 *   409 { error: 'already_verified' } this human already verified an operator
 *   502 { error: 'verify_unreachable' }
 *   503 { error: 'not_configured' }  World ID env not set — CANNOT verify (fail-soft)
 *
 * Verify-only: it NEVER signs, holds, or moves money, and never leaks a payout
 * address (ADR "Security notes carried forward").
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  let tenantId: string
  try {
    ;({ tenantId } = await resolveVerifiedTenant(request, body))
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 })
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // The operator badge rides on the branding row; the operator sets name/logo
  // first (the onboarding gates this). No row → tell them plainly.
  const existing = getByTenant(tenantId)
  if (!existing) {
    return NextResponse.json({ error: 'no_branding' }, { status: 400 })
  }

  // C-2: derive the action ONLY from trusted server config and OVERRIDE any body-supplied action in
  // the payload forwarded to the portal, so a proof generated for a different scope cannot be replayed
  // here; the nullifier is then claimed under this same server action (never result.action).
  const action = worldOperatorAction()
  const sealed =
    typeof body === 'object' && body !== null
      ? { ...(body as Record<string, unknown>), action }
      : body
  const result = await verifyWorldProof(sealed, action)

  if (!result.ok) {
    if (result.code === 'not_configured') {
      return NextResponse.json({ error: 'not_configured' }, { status: 503 })
    }
    if (result.code === 'verify_unreachable') {
      return NextResponse.json({ error: 'verify_unreachable' }, { status: 502 })
    }
    return NextResponse.json({ error: 'proof_invalid', code: result.code }, { status: 401 })
  }

  // One human, one operator slot.
  let fresh: boolean
  try {
    fresh = claimNullifier(action, result.nullifier)
  } catch {
    return NextResponse.json({ error: 'bad_nullifier' }, { status: 400 })
  }
  if (!fresh) {
    return NextResponse.json({ error: 'already_verified' }, { status: 409 })
  }

  // Record the operator badge on the row. Pass the existing display name so the
  // re-upsert keeps name/logo intact; this is the write that lets a casino save.
  try {
    const row = upsertBranding({
      tenantId,
      displayName: existing.displayName,
      verifiedOperator: true,
      operatorNullifier: result.nullifier,
    })
    return NextResponse.json({ branding: row }, { status: 200 })
  } catch (err) {
    if (err instanceof BrandingError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
}
