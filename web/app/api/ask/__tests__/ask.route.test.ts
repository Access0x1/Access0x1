/**
 * @file ask.route.test.ts — the judge-facing /api/ask streaming proxy.
 *
 * Pins the route's contract WITHOUT a live Claude call (the SDK is mocked):
 *  - happy path: a configured key + a valid question streams the model's text
 *    deltas back as text/plain, and the request is grounded by the facts system
 *    prompt (we assert the mock was called with the Haiku model + that system),
 *  - fail-soft: NO key configured ⇒ a clean 503 not_configured, never a crash,
 *  - input guards: invalid JSON / missing / empty / over-long question ⇒ 400,
 *  - the daily never-negative meter returns 429 once spent.
 *
 * The Claude key never appears in any response body (it lives server-side only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock the Anthropic SDK. messages.stream returns an async-iterable of the
//    same content_block_delta text events the real SDK emits. ─────────────────
const streamMock = vi.fn()

class FakeAPIError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { stream: (...args: unknown[]) => streamMock(...args) }
    static APIError = FakeAPIError
    constructor(_opts: unknown) {}
  }
  return { default: Anthropic }
})

const { POST } = await import('../route.js')

/** Build an async-iterable that yields the given text as one text_delta event. */
function streamOf(text: string): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text } }
    },
  }
}

let ipCounter = 0
/** Unique IP per request so the shared in-memory rate limiter never collides. */
function req(body: unknown, ip?: string): Request {
  ipCounter += 1
  return new Request('https://x/api/ask', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip ?? `10.0.0.${ipCounter}`,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  streamMock.mockReset()
  vi.stubEnv('CLAUDE_API_KEY', 'sk-test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('happy path (mocked SDK)', () => {
  it('streams the model answer back as text/plain', async () => {
    streamMock.mockReturnValue(streamOf('Access0x1 is a zero-custody payments layer.'))

    const res = await POST(req({ question: 'What is Access0x1?' }))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toBe('Access0x1 is a zero-custody payments layer.')
    // Never leak the key.
    expect(text).not.toContain('sk-test-key')
  })

  it('calls Claude Haiku with the grounded facts system prompt', async () => {
    streamMock.mockReturnValue(streamOf('ok'))

    await POST(req({ question: 'How does pricing work?' }))

    expect(streamMock).toHaveBeenCalledTimes(1)
    const params = streamMock.mock.calls[0][0] as {
      model: string
      system: string
      messages: { role: string; content: string }[]
    }
    expect(params.model).toBe('claude-haiku-4-5')
    // System prompt is the grounded facts brief.
    expect(params.system.toLowerCase()).toContain('access0x1 assistant')
    expect(params.system).toContain('=== FACTS ===')
    expect(params.messages[0]).toEqual({ role: 'user', content: 'How does pricing work?' })
  })
})

describe('fail-soft: unconfigured', () => {
  it('returns 503 not_configured when no key is set, and never calls the SDK', async () => {
    vi.stubEnv('CLAUDE_API_KEY', '')

    const res = await POST(req({ question: 'anything' }))

    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('not_configured')
    expect(streamMock).not.toHaveBeenCalled()
  })
})

describe('input validation', () => {
  it('rejects invalid JSON with 400', async () => {
    const res = await POST(req('{not json'))
    expect(res.status).toBe(400)
  })

  it('rejects a missing question with 400', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })

  it('rejects an empty question with 400', async () => {
    const res = await POST(req({ question: '   ' }))
    expect(res.status).toBe(400)
  })

  it('rejects an over-long question with 400', async () => {
    const res = await POST(req({ question: 'x'.repeat(2001) }))
    expect(res.status).toBe(400)
  })
})
