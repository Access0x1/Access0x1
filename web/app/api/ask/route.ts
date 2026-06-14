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
 *  - Rate-limited to 10 requests/min per IP (in-memory; swap for a shared store
 *    in prod) and a never-negative daily request cap (429 when spent).
 *
 * Model: Haiku (claude-haiku-4-5) — set deliberately; this route keeps it.
 */

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 1024
const RATE_LIMIT = 10 // requests per window
const RATE_WINDOW_MS = 60_000 // 1 minute
const DAILY_REQUEST_CAP = 500 // never-negative meter: hard ceiling per UTC day
const MAX_QUESTION_LEN = 2000

// The grounded system prompt is stable for the life of the process — build once.
const SYSTEM_PROMPT = buildSystemPrompt()

// --- in-memory meters (per server instance; fine for a hackathon / single node) ---
const ipHits = new Map<string, { count: number; resetAt: number }>()
let dayBudget = { day: utcDay(), remaining: DAILY_REQUEST_CAP }

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Sliding fixed-window per-IP limiter. Returns true if the request is allowed. */
function allowIp(ip: string): boolean {
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

/** Never-negative daily meter: decrement only if budget remains; resets at UTC midnight. */
function spendDailyBudget(): boolean {
  const today = utcDay()
  if (dayBudget.day !== today) {
    dayBudget = { day: today, remaining: DAILY_REQUEST_CAP }
  }
  if (dayBudget.remaining <= 0) return false
  dayBudget.remaining -= 1
  return true
}

/** Small JSON error helper that never leaks internals. */
function jsonError(error: string, status: number, code?: string): Response {
  return new Response(JSON.stringify(code ? { error, code } : { error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.CLAUDE_API_KEY
  if (!apiKey) {
    // No key configured: the assistant is optional, so fail soft with a clear
    // machine-readable not_configured status — never crash.
    return jsonError('Assistant is not configured on this deployment.', 503, 'not_configured')
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'

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
