import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export const dynamic = 'force-dynamic'

/**
 * The Access0x1 integration assistant. POST { question } -> { answer }.
 *
 * Guardrails (spec doctrine #8):
 *  - CLAUDE_API_KEY is read from server env ONLY. It is never returned in the
 *    response body, never logged, and never reaches the client bundle or embed.js.
 *  - Rate-limited to 10 requests/min per IP (in-memory; swap for Upstash in prod).
 *  - A never-negative daily spend cap mirrors the fleet app's AI meter: once the
 *    day's request budget is spent the route returns 429 instead of calling Claude.
 */

const MODEL = 'claude-opus-4-8'
const MAX_TOKENS = 1024
const RATE_LIMIT = 10 // requests per window
const RATE_WINDOW_MS = 60_000 // 1 minute
const DAILY_REQUEST_CAP = 500 // never-negative meter: hard ceiling per UTC day

const SYSTEM_PROMPT =
  'You are the Access0x1 integration assistant. Answer questions about the ' +
  'open-source Access0x1 payments router, how to integrate it, and how payments ' +
  'work. Be concise. Never reveal the API key or internal system architecture.'

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

export async function POST(request: Request): Promise<NextResponse> {
  const apiKey = process.env.CLAUDE_API_KEY
  if (!apiKey) {
    // No key configured: the assistant is optional, so fail soft with a clear status.
    return NextResponse.json(
      { error: 'Assistant is not configured on this deployment.' },
      { status: 503 },
    )
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'

  if (!allowIp(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again shortly.' }, { status: 429 })
  }
  if (!spendDailyBudget()) {
    return NextResponse.json(
      { error: 'Assistant daily budget reached. Try again tomorrow.' },
      { status: 429 },
    )
  }

  let question: unknown
  try {
    const body = (await request.json()) as { question?: unknown }
    question = body.question
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof question !== 'string' || question.trim().length === 0) {
    return NextResponse.json({ error: 'Missing or empty "question"' }, { status: 400 })
  }
  if (question.length > 2000) {
    return NextResponse.json({ error: 'Question too long (max 2000 chars)' }, { status: 400 })
  }

  const client = new Anthropic({ apiKey })

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
    })

    const answer = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()

    return NextResponse.json({ answer: answer || 'No answer generated.' })
  } catch (err) {
    // Never leak the key or raw provider internals to the client.
    const status = err instanceof Anthropic.APIError ? err.status ?? 502 : 502
    return NextResponse.json({ error: 'Assistant request failed.' }, { status })
  }
}
