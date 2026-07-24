/**
 * @file docs-ask.route.test.ts — the docs-grounded /api/docs-ask streaming proxy.
 *
 * Pins the route's contract WITHOUT a live Claude call (the SDK is mocked):
 *  - happy path: a configured key + a valid question streams the model's text
 *    deltas back as text/plain, grounded by the DOCS system prompt, which is sent
 *    as a cache-controlled block (we assert the mock was called with the Haiku
 *    model, a system[0].text carrying the grounding instruction + a real doc
 *    filename, and cache_control: ephemeral),
 *  - fail-soft: NO key configured ⇒ a clean 503 not_configured, never a crash,
 *  - capability probe: GET ⇒ { configured },
 *  - input guards: invalid JSON / missing / empty / over-long question ⇒ 400,
 *  - the per-IP limiter returns 429, and the daily never-negative meter returns
 *    429 once spent.
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

const { GET, POST, __resetDocsAskMetersForTests } = await import('../route.js')

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
  return new Request('https://x/api/docs-ask', {
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
  __resetDocsAskMetersForTests()
  vi.stubEnv('CLAUDE_API_KEY', 'sk-test-key')
  // The limiter keys on a TRUSTED proxy-set IP. Tell the route it is behind a
  // trusted proxy so the per-request x-forwarded-for IP is honored (single hop ⇒
  // first==last), preserving the unique-IP-per-request isolation these tests rely on.
  vi.stubEnv('ASK_TRUST_PROXY', 'true')
})

afterEach(() => {
  vi.unstubAllEnvs()
  __resetDocsAskMetersForTests()
})

describe('happy path (mocked SDK)', () => {
  it('streams the model answer back as text/plain', async () => {
    streamMock.mockReturnValue(streamOf('The router never holds merchant funds (docs/FAQ.md).'))

    const res = await POST(req({ question: 'Does the router hold funds?' }))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toBe('The router never holds merchant funds (docs/FAQ.md).')
    // Never leak the key.
    expect(text).not.toContain('sk-test-key')
  })

  it('calls Claude Haiku with the docs system prompt sent as a cache-controlled block', async () => {
    streamMock.mockReturnValue(streamOf('ok'))

    await POST(req({ question: 'How is a payment priced?' }))

    expect(streamMock).toHaveBeenCalledTimes(1)
    const params = streamMock.mock.calls[0][0] as {
      model: string
      system: { type: string; text: string; cache_control?: { type: string } }[]
      messages: { role: string; content: string }[]
    }
    expect(params.model).toBe('claude-haiku-4-5')
    // System is a text-block ARRAY (not a bare string) so it can be cached.
    expect(Array.isArray(params.system)).toBe(true)
    expect(params.system).toHaveLength(1)
    const block = params.system[0]
    expect(block.type).toBe('text')
    // The corpus is marked for prompt caching — the key efficiency win.
    expect(block.cache_control).toEqual({ type: 'ephemeral' })
    // The grounding instruction + a real doc citation header are present.
    expect(block.text).toContain('documentation assistant')
    expect(block.text).toContain('Cite the source doc filename')
    expect(block.text).toContain('===== docs/FAQ.md =====')
    expect(params.messages[0]).toEqual({ role: 'user', content: 'How is a payment priced?' })
  })
})

describe('0G Compute path — global switch AI_INFERENCE_PROVIDER=zerog', () => {
  it('answers the SAME grounded corpus on 0G and tags x-inference-provider: zerog', async () => {
    vi.stubEnv('AI_INFERENCE_PROVIDER', 'zerog')
    vi.stubEnv('ZEROG_COMPUTE_ENDPOINT', 'https://compute.0g')
    vi.stubEnv('ZEROG_COMPUTE_API_KEY', 'k')
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ model: 'llama-x', choices: [{ message: { content: 'Priced in USD (docs/FAQ.md).' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(req({ question: 'How is a payment priced?' }))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('x-inference-provider')).toBe('zerog')
    expect(await res.text()).toBe('Priced in USD (docs/FAQ.md).')

    // The 0G call is OpenAI-compatible, with the docs corpus sent as the system message.
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://compute.0g/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toContain('===== docs/FAQ.md =====')
    expect(body.messages[1]).toEqual({ role: 'user', content: 'How is a payment priced?' })
    expect(streamMock).not.toHaveBeenCalled() // the Anthropic streaming path is untouched
  })

  it('GET probe reports configured from the 0G env even with no Claude key', async () => {
    vi.stubEnv('CLAUDE_API_KEY', '')
    vi.stubEnv('AI_INFERENCE_PROVIDER', 'zerog')
    vi.stubEnv('ZEROG_COMPUTE_ENDPOINT', 'https://compute.0g')
    vi.stubEnv('ZEROG_COMPUTE_API_KEY', 'k')
    const res = await GET()
    expect(await res.json()).toEqual({ configured: true })
  })
})

describe('capability probe (GET) — the UI gates the assistant on this flag', () => {
  it('reports { configured: true } when the key is set — and never leaks the key', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ configured: true })
    expect(text).not.toContain('sk-test-key')
  })

  it('reports { configured: false } when no key is set, without calling the SDK', async () => {
    vi.stubEnv('CLAUDE_API_KEY', '')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ configured: false })
    expect(streamMock).not.toHaveBeenCalled()
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

describe('per-IP rate limit', () => {
  it('returns 429 rate_limited on the 11th request from one trusted IP within the window', async () => {
    streamMock.mockReturnValue(streamOf('ok'))

    let last: Response | undefined
    for (let i = 0; i < 11; i++) {
      last = await POST(
        new Request('https://x/api/docs-ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-real-ip': '10.5.5.5' },
          body: JSON.stringify({ question: 'hi' }),
        }),
      )
    }
    expect(last!.status).toBe(429)
    const body = (await last!.json()) as { code: string }
    expect(body.code).toBe('rate_limited')
  })
})

describe('hard server-side spend cap', () => {
  it('returns 429 daily_cap once the daily request budget is exhausted', async () => {
    streamMock.mockReturnValue(streamOf('ok'))
    // Distinct trusted IP per request so the per-IP minute limiter never trips;
    // the daily request cap (500) is what we want to hit.
    async function ask(n: number) {
      return POST(
        new Request('https://x/api/docs-ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-real-ip': `10.1.${Math.floor(n / 250)}.${n % 250}` },
          body: JSON.stringify({ question: 'hi' }),
        }),
      )
    }
    let exhausted: Response | undefined
    for (let i = 0; i < 501; i++) {
      exhausted = await ask(i)
    }
    expect(exhausted!.status).toBe(429)
    const body = (await exhausted!.json()) as { code: string }
    expect(body.code).toBe('daily_cap')
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
