import {
  COST_RING_CAPACITY,
  DOCS_ASK_DAILY_REQUEST_CAP,
  HAIKU_4_5_PRICES,
  readCostRecords,
  summarizeCost,
} from '@/lib/docs/cost-meter.js'

export const dynamic = 'force-dynamic'

/**
 * The documentation assistant's cost meter. GET /api/docs-ask/meter -> the last
 * {@link COST_RING_CAPACITY} answers plus the aggregates that decide whether the
 * corpus prompt-cache block is earning its keep.
 *
 * The assistant marks its ~130K-token corpus `cache_control: ephemeral`. Anthropic
 * bills that block at 1.25x on a cache WRITE and 0.1x on a cache READ, so caching
 * beats sending the corpus uncached ONLY above a 21.74% hit rate, served here as
 * `summary.breakEvenHitRate` so a client compares against it without hard-coding
 * the constant. Against sporadic traffic and a 5-minute
 * default cache TTL, which side of that line a deployment sits on is an empirical
 * question — this endpoint answers it from measured `usage`, never from a model.
 *
 * PRIVACY: the response carries token counts, dollar figures, cache states, and
 * timestamps. It carries NO question text, NO answer text, and NO IP — the ring
 * buffer never stores any of them (see lib/docs/cost-meter.ts). Even so the route
 * is env-gated, because per-deployment spend figures are operational data rather
 * than public documentation.
 *
 * Gate: `DOCS_ASK_METER_PUBLIC=true` serves the meter; anything else returns 404,
 * so an ungated deployment does not even advertise that the surface exists.
 */

/** True only for an explicit opt-in — a blank or absent var keeps the meter closed. */
function meterEnabled(): boolean {
  return (process.env.DOCS_ASK_METER_PUBLIC ?? '').trim().toLowerCase() === 'true'
}

/**
 * Serve the meter.
 *
 * @returns 200 with `{ recent, summary, prices, ... }` when enabled, else a 404
 *   `{ error, code: 'not_enabled' }`. Always `no-store`: a cached spend figure is
 *   a wrong spend figure.
 */
export async function GET(): Promise<Response> {
  if (!meterEnabled()) {
    return new Response(JSON.stringify({ error: 'Not found', code: 'not_enabled' }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  const recent = readCostRecords()
  const body = {
    /** The buffered answers, oldest first. Numbers, cache state, timestamp only. */
    recent,
    /** Hit rate, mean cost, daily projection, and the with/without-cache spread. */
    summary: summarizeCost(recent, DOCS_ASK_DAILY_REQUEST_CAP),
    /** The list prices every figure above is derived from, echoed for auditability. */
    prices: HAIKU_4_5_PRICES,
    /** The request ceiling `projectedDailyUsd` extrapolates to. */
    dailyRequestCap: DOCS_ASK_DAILY_REQUEST_CAP,
    /** How many answers the ring buffer holds before evicting the oldest. */
    bufferCapacity: COST_RING_CAPACITY,
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
