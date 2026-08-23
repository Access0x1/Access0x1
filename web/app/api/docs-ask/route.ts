import Anthropic from '@anthropic-ai/sdk'

import { buildDocsSystemPrompt } from '@/lib/docs/corpus.js'
import {
  DOCS_ASK_DAILY_REQUEST_CAP,
  EMPTY_USAGE,
  mergeUsageFrame,
  recordAnswerUsage,
  type AnswerUsage,
} from '@/lib/docs/cost-meter.js'
import { DEFAULT_TOP_K, buildRetrievedSystemPrompt } from '@/lib/docs/retrieve.js'
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
 * Efficiency — TWO GROUNDING MODES, selected by `DOCS_ASK_MODE`:
 *
 *  - `rag` (the DEFAULT) sends only the documentation passages this question
 *    ranks for, retrieved by the BM25 index in lib/docs/retrieve.ts. Measured on
 *    the five one-click questions the prompt runs 6,479–9,660 bytes against
 *    492,981 for the whole corpus — a bill that is the same warm or cold,
 *    because it no longer depends on a cache being hot.
 *  - `corpus` restores the previous behavior verbatim: the whole ~496KB corpus,
 *    built ONCE and sent as a single `cache_control: ephemeral` block so
 *    Anthropic caches it and charges cache-read (~0.1x) on repeat requests. It
 *    is the recall-maximizing mode, the A/B control, and the fallback.
 *
 * WHY the retrieval prompt carries NO cache block: it differs per question, so a
 * cache write would be paid on every request and read back on none — buying a
 * 1.25x multiplier for nothing. What is left of a stable prefix after retrieval
 * is the instruction text, far under Anthropic's minimum cacheable prefix.
 *
 * The corpus mode's win is conditional, which is why the route MEASURES it. A
 * cache write costs 1.25x, so below a 21.74% hit rate the cached block bills
 * MORE than sending the corpus uncached. The streaming loop folds every
 * `message_start` / `message_delta` usage frame into lib/docs/cost-meter.ts,
 * which costs the answer and keeps the last 50 on a bounded ring buffer; GET
 * /api/docs-ask/meter serves the resulting hit rate and daily projection. Token
 * counts only — no question, no answer, no IP is ever recorded.
 */

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 1024
const RATE_LIMIT = 10 // requests per window
const RATE_WINDOW_MS = 60_000 // 1 minute
// The cap lives in the cost meter so the daily SPEND projection served by
// /api/docs-ask/meter can never drift away from the request ceiling it projects.
const DAILY_REQUEST_CAP = DOCS_ASK_DAILY_REQUEST_CAP // never-negative meter: hard ceiling per UTC day
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

/** How a question is grounded — see the `DOCS_ASK_MODE` note in the file header. */
type DocsAskMode = 'rag' | 'corpus'

/**
 * Resolve the grounding mode from `DOCS_ASK_MODE`.
 *
 * Retrieval is the DEFAULT because it is the cheaper path and the only one whose
 * cost is independent of traffic shape. `corpus` is the explicit opt-out, kept
 * permanently: a retrieval regression must never mean a broken assistant, and
 * whole-corpus recall is the control an answer-quality A/B measures against.
 *
 * THE DEFAULT IS `corpus`, deliberately, and flipping it is an OWNER decision.
 * Two reasons, both measured. (1) The cost meter shipped one commit earlier
 * exists to discover the cache hit rate nobody has ever measured; `rag` produces
 * no cache activity at all, so defaulting to it makes the meter unable to answer
 * the question it was built for. Measure first, then switch. (2) An answer-quality
 * A/B has not run: retrieval demonstrably surfaces the answering passage for the
 * five one-click questions and nine committed topics, and it demonstrably does
 * NOT surface `docs/CHAIN-ADDRESSES.md` inside the top-8 for address-shaped
 * questions. That gap is a product decision, not an implementation detail.
 *
 * Set `DOCS_ASK_MODE=rag` to switch. Anything other than the literal `rag` reads
 * as `corpus`, so a typo keeps the known-good recall rather than silently
 * degrading answers.
 */
function docsAskMode(): DocsAskMode {
  return (process.env.DOCS_ASK_MODE ?? '').trim().toLowerCase() === 'rag' ? 'rag' : 'corpus'
}

/**
 * How many passages retrieval may send. Reads `DOCS_ASK_TOP_K` and falls back to
 * {@link DEFAULT_TOP_K} for a blank, non-numeric, or non-positive value — never
 * a silent zero, which would ground the model in nothing.
 */
function docsAskTopK(): number {
  const raw = Number((process.env.DOCS_ASK_TOP_K ?? '').trim())
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TOP_K
}

/** The system prompt chosen for one question, in both shapes the providers need. */
interface GroundedPrompt {
  /** The prompt as plain text — what the OpenAI-compatible providers take. */
  readonly text: string
  /** The same prompt as Anthropic system blocks. */
  readonly blocks: Anthropic.TextBlockParam[]
  /** Which mode actually produced it, after any fallback. */
  readonly mode: DocsAskMode
}

/**
 * Ground one question: the retrieved passages in `rag` mode, the whole corpus in
 * `corpus` mode.
 *
 * Retrieval that finds NOTHING above its relevance floor falls back to the whole
 * corpus rather than asking the model to answer from an empty context. That
 * costs a whole-corpus request in the rare no-match case, which is exactly what
 * every request cost before this change — the daily cap already bounds that
 * ceiling, so the fallback can restore the old bill and never exceed it.
 *
 * The retrieval prompt is deliberately sent WITHOUT `cache_control`: a
 * per-question prefix would pay the 1.25x write on every request and read it
 * back on none.
 *
 * @param question - the user's question, already validated.
 * @returns the prompt to send, plus the mode that produced it.
 */
function groundQuestion(question: string): GroundedPrompt {
  const corpus: GroundedPrompt = { text: SYSTEM_PROMPT, blocks: SYSTEM_BLOCKS, mode: 'corpus' }
  if (docsAskMode() === 'corpus') return corpus
  const retrieved = buildRetrievedSystemPrompt(question, docsAskTopK())
  if (!retrieved.matched) return corpus
  return { text: retrieved.prompt, blocks: [{ type: 'text', text: retrieved.prompt }], mode: 'rag' }
}

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
 * `AI_INFERENCE_PROVIDER=zerog` (0G Compute, decentralized) or `=access0x1` (Access0x1 Compute,
 * our hosted AWS-backed endpoint) the docs assistant answers there and this reports that provider's
 * config; otherwise it reports the Anthropic key. The probe shape stays `{ configured }` either way.
 */
function isDocsAssistantConfigured(): boolean {
  const provider = selectedProvider()
  return provider === 'anthropic'
    ? Boolean(process.env.CLAUDE_API_KEY)
    : isInferenceConfigured(provider)
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

  // --- Alternate-provider path: when the global switch selects 0G Compute (decentralized) or
  //     Access0x1 Compute (our hosted AWS-backed endpoint), the SAME grounded corpus is answered
  //     there. Non-streamed (one completion), tagged with the x-inference-provider header the UI
  //     badges. The Anthropic path below is otherwise unchanged.
  // Ground the question ONCE, before the provider fork: both transports send the
  // same prompt, and retrieval is what keeps it inside a 128K-context model.
  const grounded = groundQuestion(question)

  const activeProvider = selectedProvider()
  if (activeProvider !== 'anthropic') {
    try {
      const result = await runInference({
        provider: activeProvider,
        system: grounded.text,
        prompt: question,
        maxTokens: MAX_TOKENS,
      })
      return new Response(result.completion, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-inference-provider': activeProvider,
          'x-inference-model': result.model,
          'x-docs-ask-mode': grounded.mode,
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
  // text events; we forward only the text deltas to the client. The system blocks
  // come from groundQuestion — retrieved passages with no cache_control, or the
  // whole cached corpus.
  let anthropicStream: ReturnType<typeof client.messages.stream>
  try {
    anthropicStream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: grounded.blocks,
      messages: [{ role: 'user', content: question }],
    })
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? (err.status ?? 502) : 502
    return jsonError('Assistant request failed.', status, 'upstream_error')
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The usage frames ride the SAME stream as the text: `message_start`
      // carries the input side (uncached / cache-write / cache-read) and
      // `message_delta` carries the final output count. Folding them into an
      // accumulator costs one call per event and forwards nothing extra, so the
      // bytes the client receives stay exactly what they were.
      let usage: AnswerUsage = EMPTY_USAGE
      try {
        for await (const event of anthropicStream) {
          usage = mergeUsageFrame(usage, event)
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(event.delta.text))
          }
        }
      } catch {
        // Mid-stream failure: close cleanly with a short marker rather than
        // throwing (the client already has partial text). Never leak internals.
        try {
          controller.enqueue(encoder.encode('\n\n[stream interrupted]'))
        } catch {
          // controller may already be closed — ignore.
        }
      } finally {
        // Metered only AFTER the stream drains, and never allowed to affect it:
        // a throw here would strand a finished answer, so metering stays
        // best-effort and swallows its own failures.
        try {
          recordAnswerUsage(usage)
        } catch {
          // A broken meter must never break an answer.
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
      'x-docs-ask-mode': grounded.mode,
    },
  })
}
