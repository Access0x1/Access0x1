import Anthropic from '@anthropic-ai/sdk'

import { buildDocsSystemPrompt } from '@/lib/docs/corpus.js'
import { InferenceError, isInferenceConfigured, runInference, selectedProvider } from '@/lib/ai/inference'

export const dynamic = 'force-dynamic'

/**
 * The Access0x1 documentation assistant. POST { question } -> a STREAMED
 * plain-text answer (text/plain; charset=utf-8), grounded ONLY in the repo's
 * docs/*.md corpus (lib/docs/corpus.ts).
 *
 * Unlike /api/ask (which answers from a hand-curated facts brief), this route
 * answers strictly from the shipped documentation and cites the source doc
 * filename for each claim. When the answer is not in the docs it says so and
 * points at the docs index — it never invents an address, tx hash, number, or
 * claim. Testnet-only framing is enforced by the system prompt.
 *
 * Guardrails (identical to /api/ask — the same server-only, fail-soft, spend-
 * capped structure):
 *  - CLAUDE_API_KEY is read from server env ONLY (the SAME key /api/ask uses). It
 *    is never returned, never logged, and never reaches the client bundle or
 *    embed.js. The @anthropic-ai/sdk import is server-side only (next.config marks
 *    it serverExternalPackages).
 *  - Env-gated + fail-soft: with no key configured the route returns a clear
 *    not_configured 503 instead of crashing.
 *  - Rate-limited to 10 requests/min per IP and a never-negative daily request
 *    cap (429 when spent), PLUS a hard daily TOKEN cap that bounds server cost.
 *    The meters are pinned on `globalThis` under a SEPARATE key from /api/ask so
 *    the two assistants keep independent budgets.
 *  - The limiter keys on a TRUSTED proxy-set IP (via `ASK_TRUST_PROXY`), never
 *    the raw first `x-forwarded-for` value. See {@link clientIp}.
 *
 * Efficiency — PROMPT CACHING: the ~124K-token docs corpus is stable for the life
 * of the process, so the system prompt is built ONCE and sent as a single text
 * block marked `cache_control: ephemeral`. Anthropic then caches the corpus and
 * charges cache-read (~0.1x) on every subsequent request; only the per-request
 * question is uncached. The model is Haiku (200K context — the corpus fits).
 */

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 1024
const RATE_LIMIT = 10 // requests per window
const RATE_WINDOW_MS = 60_000 // 1 minute
const DAILY_REQUEST_CAP = 500 // never-negative meter: hard ceiling per UTC day
const DAILY_TOKEN_CAP = DAILY_REQUEST_CAP * MAX_TOKENS // hard server-side spend cap
const MAX_QUESTION_LEN = 2000

// The grounded system prompt (the docs corpus) is stable for the life of the
// process — build once, then reuse the SAME cache-controlled block every request.
const SYSTEM_PROMPT = buildDocsSystemPrompt()

/**
 * The system parameter as a single cache-controlled text block. Marking the large,
 * stable corpus `ephemeral` lets Anthropic cache it and bill cache-reads on repeat
 * requests, so only the short per-request question is ever uncached.
 */
const SYSTEM_BLOCKS: Anthropic.TextBlockParam[] = [
  { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
]

// --- meters, pinned on globalThis under a key SEPARATE from /api/ask so the two
//     assistants never share a budget ---
const GLOBAL_KEY = '__ax1_docs_ask_meters__'

interface DocsAskMeters {
  ipHits: Map<string, { count: number; resetAt: number }>
  dayBudget: { day: string; remaining: number; tokensRemaining: number }
}

function meters(): DocsAskMeters {
  const g = globalThis as unknown as Record<string, DocsAskMeters | undefined>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      ipHits: new Map(),
      dayBudget: { day: utcDay(), remaining: DAILY_REQUEST_CAP, tokensRemaining: DAILY_TOKEN_CAP },
    }
  }
  return g[GLOBAL_KEY] as DocsAskMeters
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Derive the client IP from a TRUSTED, proxy-set source — never the raw FIRST
 * `x-forwarded-for` value, which the client controls.
 *
 * When `ASK_TRUST_PROXY=true` (the app is behind a single trusted reverse proxy /
 * CDN that appends the real client IP — the SAME flag /api/ask uses, since both
 * routes sit behind the same proxy), read the proxy-set `x-real-ip`, then fall
 * back to the LAST hop of `x-forwarded-for`. When the flag is OFF (no trusted
 * proxy, e.g. local dev), DO NOT trust forwarding headers at all and bucket
 * everyone under one key, so the limiter degrades to a shared global limiter
 * rather than a spoofable one.
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
 * the hard token cap bounds server-side Claude spend even if request-shaped abuse
 * slips past the per-IP limiter. Decrements only on success (CEI).
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
export function __resetDocsAskMetersForTests(): void {
  const g = globalThis as unknown as Record<string, DocsAskMeters | undefined>
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
 * Capability probe: GET /api/docs-ask -> `{ configured: boolean }`.
 *
 * The UI gates every documentation-assistant affordance on this flag so an
 * unconfigured deployment HIDES the widget (or shows an honest disabled state)
 * instead of a dead button that errors on click. Reads the SAME env the POST
 * handler checks and reveals ONLY a boolean — never the key, never any env
 * detail. `no-store` so configuring a key later is picked up immediately.
 */
/**
 * Whether the assistant is configured for its ACTIVE provider (the global inference switch). With
 * `AI_INFERENCE_PROVIDER=zerog` the docs assistant answers on 0G Compute and this reports the 0G
 * config; otherwise it reports the Anthropic key. The probe shape stays `{ configured }` either way.
 */
function isDocsAssistantConfigured(): boolean {
  return selectedProvider() === 'zerog'
    ? isInferenceConfigured('zerog')
    : Boolean(process.env.CLAUDE_API_KEY)
}

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ configured: isDocsAssistantConfigured() }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export async function POST(request: Request): Promise<Response> {
  if (!isDocsAssistantConfigured()) {
    // No provider configured: the assistant is optional, so fail soft with a clear
    // machine-readable not_configured status — never crash.
    return jsonError('Assistant is not configured on this deployment.', 503, 'not_configured')
  }

  // Key on a TRUSTED proxy-set IP, never the raw first x-forwarded-for value.
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

  // --- 0G Compute path: when the global switch selects 0G, the SAME grounded corpus is answered on
  //     0G's decentralized inference network. Non-streamed (one completion), tagged with the
  //     x-inference-provider header the UI badges. The Anthropic path below is otherwise unchanged.
  if (selectedProvider() === 'zerog') {
    try {
      const result = await runInference({
        provider: 'zerog',
        system: SYSTEM_PROMPT,
        prompt: question,
        maxTokens: MAX_TOKENS,
      })
      return new Response(result.completion, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-inference-provider': 'zerog',
          'x-inference-model': result.model,
        },
      })
    } catch (err) {
      if (err instanceof InferenceError) {
        const status = err.reason === 'not_configured' ? 503 : err.reason === 'invalid-args' ? 400 : 502
        const code = err.reason === 'not_configured' ? 'not_configured' : 'upstream_error'
        return jsonError('Assistant request failed.', status, code)
      }
      return jsonError('Assistant request failed.', 502, 'upstream_error')
    }
  }

  const apiKey = process.env.CLAUDE_API_KEY as string
  const client = new Anthropic({ apiKey })

  // Stream the answer back as plain text. The SDK streams content_block_delta
  // text events; we forward only the text deltas to the client. The system corpus
  // is sent as a cached block (see SYSTEM_BLOCKS) so only the question is uncached.
  let anthropicStream: ReturnType<typeof client.messages.stream>
  try {
    anthropicStream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_BLOCKS,
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
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
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
      'x-inference-provider': 'anthropic',
    },
  })
}
