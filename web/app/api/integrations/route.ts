import { NextResponse } from 'next/server'

import { INTEGRATIONS, allStatuses } from '@/lib/config/integrations'

/**
 * GET /api/integrations — ONE endpoint that answers "what is actually wired up?"
 * for every external API the app can use, under our own roof.
 *
 * Everything derives from `lib/config/integrations.ts`, so a new provider shows
 * up here the moment it is declared — there is no second list to update.
 *
 * SECURITY — this route exists precisely because it is the SAFE way to expose
 * configuration state:
 *   - It returns variable NAMES and set/unset booleans ONLY. No value, no
 *     prefix, no length, no fingerprint. A response cannot leak a credential
 *     because a credential never enters the payload.
 *   - `secretVars` lists which names are secrets so a client can render the
 *     right warning, without implying the value is available here.
 *   - `no-store`: this is live operator state, never cacheable.
 *
 * Doctrine: reporting `configured: false` is a truthful answer, not an error.
 * The route is always 200 — an unconfigured app is a working app with dormant
 * seams, and a 5xx here would wrongly read as "the deployment is broken".
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const statuses = allStatuses((name) => process.env[name])

  const demo = statuses.filter((s) => s.impact === 'demo')
  const body = {
    /** Per-integration state: configured | partial | off (never a value). */
    integrations: statuses.map((s) => {
      const meta = INTEGRATIONS.find((i) => i.id === s.id)
      return {
        ...s,
        unlocks: meta?.unlocks ?? '',
        /** Names only — where to get them lives in the docs, not in a payload. */
        secretVars: (meta?.vars ?? []).filter((v) => v.secret).map((v) => v.name),
      }
    }),
    /** At-a-glance readiness for the surfaces a live demo depends on. */
    demoReadiness: { ready: demo.filter((s) => s.ready).length, total: demo.length },
    /**
     * `partial` is surfaced separately because it is the dangerous state: half
     * configured reads as "on" at a glance while the call silently fails.
     */
    partial: statuses.filter((s) => s.state === 'partial').map((s) => s.id),
  }

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
