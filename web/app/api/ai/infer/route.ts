/**
 * /api/ai/infer — provider-switchable AI inference (Anthropic default | 0G Compute).
 *
 * A plain, env-gated inference endpoint that runs the completion through the selected provider
 * ({@link runInference}). Flip `AI_INFERENCE_PROVIDER=zerog` (+ `ZEROG_COMPUTE_*`) and the SAME
 * endpoint serves inference from **0G Compute** — 0G's decentralized inference network — instead of
 * Anthropic. This is the concrete "AI runs on 0G" surface.
 *
 *   GET  /api/ai/infer                 → { configured, provider } capability probe
 *   POST /api/ai/infer { prompt }      → { provider, model, completion }
 *
 * FAIL-SOFT (law #4): the selected provider being unconfigured returns 503 `not_configured` (the UI
 * probe hides the affordance), a bad body is 400, an upstream failure is 502 — never a 500 crash and
 * never a faked completion. Server-only: neither provider key reaches the browser.
 *
 * ABUSE GUARD (R-6, ported from /api/ask + /api/docs-ask): this route spends a PAID server credential
 * per call (CLAUDE_API_KEY, or in 0G broker mode a funded operator wallet that settles a real tx), so
 * it is NOT left open. A per-IP sliding-window limiter (10 req/min) plus a never-negative daily
 * request AND token budget bound server cost even under request-shaped abuse; the caller's `maxTokens`
 * is clamped to a fixed ceiling so a single call cannot request an unbounded completion. The limiter
 * keys on a TRUSTED proxy-set IP (never the client-spoofable first `x-forwarded-for` hop); without a
 * trusted proxy it degrades to a shared global limiter rather than a spoofable one.
 */

import { isInferenceConfigured, runInference, selectedProvider, InferenceError } from '@/lib/ai/inference'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_PROMPT_LEN = 4000
const MAX_TOKENS_CEIL = 2048 // hard clamp on caller-supplied maxTokens (bounds a single call)
const RATE_LIMIT = 10 // requests per window, per IP
const RATE_WINDOW_MS = 60_000 // 1 minute
const DAILY_REQUEST_CAP = 500 // never-negative meter: hard ceiling per UTC day
const DAILY_TOKEN_CAP = DAILY_REQUEST_CAP * MAX_TOKENS_CEIL // hard server-side spend cap (R-6)

// --- meters, pinned on globalThis so N route-module instances share ONE budget (R-6) ---
const GLOBAL_KEY = '__ax1_infer_meters__'

interface InferMeters {
  ipHits: Map<string, { count: number; resetAt: number }>
  dayBudget: { day: string; remaining: number; tokensRemaining: number }
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function meters(): InferMeters {
  const g = globalThis as unknown as Record<string, InferMeters | undefined>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      ipHits: new Map(),
      dayBudget: { day: utcDay(), remaining: DAILY_REQUEST_CAP, tokensRemaining: DAILY_TOKEN_CAP },
    }
  }
  return g[GLOBAL_KEY] as InferMeters
}

/**
 * Derive the client IP from a TRUSTED, proxy-set source — never the raw FIRST
 * `x-forwarded-for` value, which the client controls (R-6). Reuses `ASK_TRUST_PROXY`
 * (the app-wide "is there a trusted proxy in front" flag); OFF ⇒ everyone buckets
 * under one key so the per-IP limiter degrades to a shared limiter, not a spoofable one.
 */
function clientIp(request: Request): string {
  const trustProxy = (process.env.ASK_TRUST_PROXY ?? '').trim().toLowerCase() === 'true'
  if (!trustProxy) return 'shared'
  const realIp = request.headers.get('x-real-ip')?.trim()
  if (realIp) return realIp
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean)
    if (hops.length > 0) return hops[hops.length - 1]
  }
  return 'unknown'
}

/** Sliding fixed-window per-IP limiter. Returns true if the request is allowed. */
function allowIp(ip: string): boolean {
  const { ipHits } = meters()
  const now = Date.now()
  const entry = ipHits.get(ip)
  if (!entry || now >= entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (entry.count >= RATE_LIMIT) return false
  entry.count += 1
  return true
}

/**
 * Never-negative daily meter: charges a request and `tokens` of budget, resetting at
 * UTC midnight. Returns true only when BOTH budgets have headroom, so the hard token
 * cap bounds server-side spend even if request-shaped abuse slips past the per-IP
 * limiter. Decrements only when allowed (CEI).
 */
function spendDailyBudget(tokens: number): boolean {
  const m = meters()
  const today = utcDay()
  if (m.dayBudget.day !== today) {
    m.dayBudget = { day: today, remaining: DAILY_REQUEST_CAP, tokensRemaining: DAILY_TOKEN_CAP }
  }
  if (m.dayBudget.remaining <= 0 || m.dayBudget.tokensRemaining < tokens) return false
  m.dayBudget.remaining -= 1
  m.dayBudget.tokensRemaining -= tokens
  return true
}

/**
 * Test-only: reset the globalThis-pinned meters so each test starts from a clean
 * per-IP limiter + full daily request/token budget. Production never calls this.
 */
export function __resetInferMetersForTests(): void {
  const g = globalThis as unknown as Record<string, InferMeters | undefined>
  g[GLOBAL_KEY] = {
    ipHits: new Map(),
    dayBudget: { day: utcDay(), remaining: DAILY_REQUEST_CAP, tokensRemaining: DAILY_TOKEN_CAP },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** Capability probe — reveals only whether the selected provider is configured (never a key). */
export async function GET(): Promise<Response> {
  return json({ configured: isInferenceConfigured(), provider: selectedProvider() })
}

export async function POST(request: Request): Promise<Response> {
  if (!isInferenceConfigured()) {
    return json(
      { error: 'AI inference is not configured on this deployment.', code: 'not_configured' },
      503,
    )
  }

  // R-6: bound cost BEFORE spending the paid credential. Key on a trusted proxy-set IP.
  const ip = clientIp(request)
  if (!allowIp(ip)) {
    return json({ error: 'Rate limit exceeded. Try again shortly.', code: 'rate_limited' }, 429)
  }

  let body: { prompt?: unknown; model?: unknown; maxTokens?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: 'invalid_json', code: 'invalid-args' }, 400)
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  if (prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LEN) {
    return json({ error: `prompt must be 1..${MAX_PROMPT_LEN} chars`, code: 'invalid-args' }, 400)
  }

  // Clamp caller-supplied maxTokens to [1, MAX_TOKENS_CEIL] so one call can't request an
  // unbounded completion; the clamped value is what we charge the daily token budget.
  const requested =
    typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens)
      ? Math.floor(body.maxTokens)
      : MAX_TOKENS_CEIL
  const maxTokens = Math.max(1, Math.min(MAX_TOKENS_CEIL, requested))

  if (!spendDailyBudget(maxTokens)) {
    return json({ error: 'Inference daily budget reached. Try again tomorrow.', code: 'daily_cap' }, 429)
  }

  try {
    const result = await runInference({
      prompt,
      model: typeof body.model === 'string' ? body.model : undefined,
      maxTokens,
    })
    return json(result, 200)
  } catch (err) {
    if (err instanceof InferenceError) {
      const status = err.reason === 'not_configured' ? 503 : err.reason === 'invalid-args' ? 400 : 502
      return json({ error: err.message, code: err.reason }, status)
    }
    return json({ error: 'inference failed', code: 'upstream_error' }, 502)
  }
}
