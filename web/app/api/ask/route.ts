import Anthropic from '@anthropic-ai/sdk'

import { buildSystemPrompt } from '@/lib/judge/facts.js'

export const dynamic = 'force-dynamic'

/**
 * The Access0x1 judge-facing Q&A assistant. POST { question } -> a STREAMED
 * plain-text answer (text/plain; charset=utf-8), grounded in lib/judge/facts.ts.
 *
 * At the booth, anyone (a judge, another builder) can ask the bot anything about
 * Access0x1 and get an accurate, grounded answer. The system prompt is the facts
 * module: the model is told to answer ONLY from those facts and to say it does
 * not know — and to ask the team — for anything it cannot ground, never inventing
 * an address or a claim.
 *
 * Guardrails:
 *  - CLAUDE_API_KEY is read from server env ONLY. It is never returned in the
 *    response body, never logged, and never reaches the client bundle or embed.js.
 *    The @anthropic-ai/sdk import is server-side only (next.config marks it
 *    serverExternalPackages).
 *  - Env-gated + fail-soft: with no key configured the route returns a clear
 *    not_configured 503 instead of crashing.
 *  - Rate-limited to 10 requests/min per IP and a never-negative daily request
 *    cap (429 when spent), PLUS a hard daily TOKEN cap (R-6) that bounds server
 *    cost even if request-shaped abuse slips through. The meters are pinned on
 *    `globalThis` so they are shared across route-module instances (and survive
 *    dev hot-reload) instead of one-per-instance.
 *  - The limiter keys on a TRUSTED proxy-set IP, never the raw first
 *    `x-forwarded-for` value (R-6): the first XFF entry is client-spoofable, so a
 *    naive key gives zero real protection. See {@link clientIp}.
 *
 * Model: Haiku (claude-haiku-4-5) — set deliberately; this route keeps it.
 */

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 1024
const RATE_LIMIT = 10 // requests per window
const RATE_WINDOW_MS = 60_000 // 1 minute
const DAILY_REQUEST_CAP = 500 // never-negative meter: hard ceiling per UTC day
const DAILY_TOKEN_CAP = DAILY_REQUEST_CAP * MAX_TOKENS // hard server-side spend cap (R-6)
const MAX_QUESTION_LEN = 2000

// The grounded system prompt is stable for the life of the process — build once.
const SYSTEM_PROMPT = buildSystemPrompt()

// --- meters, pinned on globalThis so N route-module instances share ONE budget (R-6) ---
const GLOBAL_KEY = '__ax1_ask_meters__'

interface AskMeters {
  ipHits: Map<string, { count: number; resetAt: number }>
  dayBudget: { day: string; remaining: number; tokensRemaining: number }
}

function meters(): AskMeters {
  const g = globalThis as unknown as Record<string, AskMeters | undefined>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      ipHits: new Map(),
      dayBudget: { day: utcDay(), remaining: DAILY_REQUEST_CAP, tokensRemaining: DAILY_TOKEN_CAP },
    }
  }
  return g[GLOBAL_KEY] as AskMeters
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Derive the client IP from a TRUSTED, proxy-set source — never the raw FIRST
 * `x-forwarded-for` value, which the client controls (R-6).
 *
 * When `ASK_TRUST_PROXY=true` (the app is deployed behind a single trusted
 * reverse proxy / CDN that appends the real client IP), we read the proxy-set
 * `x-real-ip`, then fall back to the LAST hop of `x-forwarded-for` — the entry
 * the trusted proxy appended, which a client cannot forge past that proxy. When
 * the flag is OFF (no trusted proxy in front — e.g. local dev), we DO NOT trust
 * forwarding headers at all and bucket everyone under a single key, so the
 * per-IP limiter degrades to a shared global limiter rather than a spoofable one.
 *
 * @param request - the incoming request.
 * @returns a stable, non-spoofable rate-limit key.
 */
function clientIp(request: Request): string {
  const trustProxy = (process.env.ASK_TRUST_PROXY ?? '').trim().toLowerCase() === 'true'
  if (!trustProxy) {
    // No trusted proxy ⇒ forwarding headers are attacker-controlled; ignore them.
    return 'shared'
  }
  const realIp = request.headers.get('x-real-ip')?.trim()
  if (realIp) return realIp
  // Trust the LAST XFF hop (proxy-appended), not the first (client-supplied).
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
 * Never-negative daily meter: charges BOTH a request and a token budget, and
 * resets at UTC midnight. Returns true only when BOTH budgets have headroom, so
 * the hard token cap (R-6) bounds server-side Claude spend even if request-shaped
 * abuse slips past the per-IP limiter. Decrements only on success (CEI).
 */
function spendDailyBudget(): boolean {
  const m = meters()
  const today = utcDay()
  if (m.dayBudget.day !== today) {
    m.dayBudget = { day: today, remaining: DAILY_REQUEST_CAP, tokensRemaining: DAILY_TOKEN_CAP }
  }
  if (m.dayBudget.remaining <= 0 || m.dayBudget.tokensRemaining < MAX_TOKENS) return false
  m.dayBudget.remaining -= 1
  m.dayBudget.tokensRemaining -= MAX_TOKENS
  return true
}

/**
 * Test-only: reset the globalThis-pinned meters so each test starts from a clean
 * per-IP limiter + full daily request/token budget. Production never calls this.
 */
export function __resetAskMetersForTests(): void {
  const g = globalThis as unknown as Record<string, AskMeters | undefined>
  g[GLOBAL_KEY] = {
    ipHits: new Map(),
    dayBudget: { day: utcDay(), remaining: DAILY_REQUEST_CAP, tokensRemaining: DAILY_TOKEN_CAP },
  }
}

/** Small JSON error helper that never leaks internals. */
function jsonError(error: string, status: number, code?: string): Response {
  return new Response(JSON.stringify(code ? { error, code } : { error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Capability probe: GET /api/ask -> `{ configured: boolean }`.
 *
 * The UI gates every "Ask Access0x1" affordance on this flag so an unconfigured
 * deployment HIDES the widget (or shows an honest disabled state) instead of a
 * dead button that errors on click. Reads the SAME env the POST handler checks
 * and reveals ONLY a boolean — never the key, never any env detail. `no-store`
 * so configuring a key later is picked up immediately, not cached away.
 */
export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ configured: Boolean(process.env.CLAUDE_API_KEY) }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.CLAUDE_API_KEY
  if (!apiKey) {
    // No key configured: the assistant is optional, so fail soft with a clear
    // machine-readable not_configured status — never crash.
    return jsonError('Assistant is not configured on this deployment.', 503, 'not_configured')
  }

  // R-6: key on a TRUSTED proxy-set IP, never the raw first x-forwarded-for value.
  const ip = clientIp(request)

  if (!allowIp(ip)) {
    return jsonError('Rate limit exceeded. Try again shortly.', 429, 'rate_limited')
  }
  if (!spendDailyBudget()) {
    return jsonError('Assistant daily budget reached. Try again tomorrow.', 429, 'daily_cap')
  }

  let question: unknown
  try {
    const body = (await request.json()) as { question?: unknown }
    question = body.question
  } catch {
    return jsonError('Invalid JSON body', 400, 'bad_request')
  }
  if (typeof question !== 'string' || question.trim().length === 0) {
    return jsonError('Missing or empty "question"', 400, 'bad_request')
  }
  if (question.length > MAX_QUESTION_LEN) {
    return jsonError(`Question too long (max ${MAX_QUESTION_LEN} chars)`, 400, 'bad_request')
  }

  const client = new Anthropic({ apiKey })

  // Stream the answer back as plain text. The SDK streams content_block_delta
  // text events; we forward only the text deltas to the client.
  let anthropicStream: ReturnType<typeof client.messages.stream>
  try {
    anthropicStream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
    })
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? (err.status ?? 502) : 502
    return jsonError('Assistant request failed.', status, 'upstream_error')
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of anthropicStream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(event.delta.text))
          }
        }
        controller.close()
      } catch {
        // Mid-stream failure: close cleanly with a short marker rather than
        // throwing (the client already has partial text). Never leak internals.
        try {
          controller.enqueue(encoder.encode('\n\n[stream interrupted]'))
        } catch {
          // controller may already be closed — ignore.
        }
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}
