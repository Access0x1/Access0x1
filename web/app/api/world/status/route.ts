/**
 * GET /api/world/status — the World ID seam's readiness report.
 *
 * The seam fails soft everywhere by design: a missing credential degrades a
 * verified-human checkout to standard rather than blocking a payment. That is
 * correct, and it is also silent — an operator staring at a checkout that never
 * offers the gate had no way to learn WHICH value was still blank. This route is
 * that answer, and it is the only intended caller of `worldReadiness()`.
 *
 * WHAT IT RETURNS: booleans for presence, env var NAMES for what is missing, the
 * environment and its verify base, the nullifier-store durability mode, and the
 * four public action strings. It NEVER returns a credential value, prefix, or
 * length (secrets law) — `WORLD_SIGNING_KEY` appears only as `present.signingKey:
 * true|false`.
 *
 * Always 200. A dormant seam is a valid, reportable state, not an error — the
 * body's `ready` and `label` carry the verdict, and `label` is the exact wording
 * the project is permitted to use in prose (law #4: `ready:false` is
 * "built, env-gated"; fully wired is "configured, unverified"). NEITHER rung is
 * "live", and nothing this route can observe would earn that word — it reads env
 * presence, which says a verify COULD complete, never that one did.
 *
 * Read-only: it verifies nothing, claims no nullifier, and touches no money.
 */

import { NextResponse } from 'next/server'
import { worldReadiness } from '@/lib/worldid/readiness'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  // Never cache a readiness report — it changes the moment an operator wires env.
  return NextResponse.json(worldReadiness(), {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}
