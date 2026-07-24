/**
 * @file infer.route.test.ts — the /api/ai/infer abuse guard (R-6) + maxTokens clamp.
 *
 * Pins the route's cost-safety contract WITHOUT a live provider call (runInference is
 * mocked): the per-IP limiter returns 429 after the window fills, the caller-supplied
 * maxTokens is clamped to the ceiling before it reaches the provider, and an
 * unconfigured provider still fails soft as 503. The paid credential is never spent
 * past these bounds — the regression the red team flagged (open, unmetered drain).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runInferenceMock = vi.fn<(req: unknown) => Promise<unknown>>()
const isConfiguredMock = vi.fn<() => boolean>(() => true)

vi.mock('@/lib/ai/inference', () => ({
  isInferenceConfigured: () => isConfiguredMock(),
  selectedProvider: () => 'anthropic',
  runInference: (req: unknown) => runInferenceMock(req),
  InferenceError: class InferenceError extends Error {
    reason: string
    constructor(reason: string, message: string) {
      super(message)
      this.reason = reason
    }
  },
}))

const { GET, POST, __resetInferMetersForTests } = await import('../route.js')

let ipCounter = 0
function req(body: unknown, ip?: string): Request {
  ipCounter += 1
  return new Request('https://x/api/ai/infer', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip ?? `10.0.0.${ipCounter}`,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  runInferenceMock.mockReset()
  runInferenceMock.mockResolvedValue({ provider: 'anthropic', model: 'm', completion: 'ok' })
  isConfiguredMock.mockReturnValue(true)
  __resetInferMetersForTests()
  // Honor the per-request x-forwarded-for IP so each request buckets separately (R-6).
  vi.stubEnv('ASK_TRUST_PROXY', 'true')
})

describe('/api/ai/infer abuse guard', () => {
  it('probe reports configured + provider, never a key', async () => {
    const res = await GET()
    const body = (await res.json()) as { configured: boolean; provider: string }
    expect(body.configured).toBe(true)
    expect(body.provider).toBe('anthropic')
  })

  it('unconfigured provider fails soft as 503', async () => {
    isConfiguredMock.mockReturnValue(false)
    const res = await POST(req({ prompt: 'hi' }))
    expect(res.status).toBe(503)
    expect(runInferenceMock).not.toHaveBeenCalled()
  })

  it('returns 429 once the per-IP window fills (10/min)', async () => {
    const ip = '203.0.113.7'
    for (let i = 0; i < 10; i++) {
      const ok = await POST(req({ prompt: 'hi' }, ip))
      expect(ok.status).toBe(200)
    }
    const blocked = await POST(req({ prompt: 'hi' }, ip))
    expect(blocked.status).toBe(429)
    const body = (await blocked.json()) as { code: string }
    expect(body.code).toBe('rate_limited')
  })

  it('clamps caller maxTokens to the ceiling before hitting the provider', async () => {
    await POST(req({ prompt: 'hi', maxTokens: 1_000_000 }))
    expect(runInferenceMock).toHaveBeenCalledTimes(1)
    const arg = runInferenceMock.mock.calls[0][0] as { maxTokens: number }
    expect(arg.maxTokens).toBe(2048)
  })

  it('rejects an empty prompt with 400 and spends nothing', async () => {
    const res = await POST(req({ prompt: '   ' }))
    expect(res.status).toBe(400)
    expect(runInferenceMock).not.toHaveBeenCalled()
  })
})
