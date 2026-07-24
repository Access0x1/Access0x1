/**
 * @file telegram.route.test.ts — the Telegram webhook: env-gate, secret check,
 * and the send → sendMessage round-trip. resolveENS + fetch are mocked (offline).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveENS = vi.fn<(input: string, chainId: number) => Promise<string>>()
class EnsResolutionError extends Error {}
vi.mock('@/lib/ens', () => ({
  resolveENS: (input: string, chainId: number) => resolveENS(input, chainId),
  EnsResolutionError,
}))
vi.mock('@/lib/chains', () => ({ getDefaultChainId: () => 84532 }))
vi.mock('@/lib/branding/checkoutHost', () => ({
  checkoutOrigin: () => 'https://pay.example',
  checkoutHost: () => 'pay.example',
}))

const { GET, POST } = await import('../route.js')

function update(text: string, chatId = 42): Request {
  return new Request('https://x/api/chat/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: { chat: { id: chatId }, text } }),
  })
}

let fetchMock: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.restoreAllMocks() // drop the previous test's fetch spy + its accumulated calls
  vi.unstubAllEnvs()
  resolveENS.mockReset()
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token')
  delete process.env.TELEGRAM_WEBHOOK_SECRET
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  )
})

describe('GET probe', () => {
  it('reports configured when the token is set', async () => {
    expect((await (await GET()).json()).configured).toBe(true)
  })
  it('reports NOT configured with no token', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '')
    expect((await (await GET()).json()).configured).toBe(false)
  })
})

describe('POST webhook', () => {
  it('503 not_configured when the token is unset', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '')
    const res = await POST(update('help'))
    expect(res.status).toBe(503)
  })

  it('send to a resolvable ENS name → replies with the checkout link', async () => {
    resolveENS.mockResolvedValue('0x' + '1'.repeat(40))
    const res = await POST(update('send 10 to maria.eth'))
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.chat_id).toBe(42)
    expect(body.text).toContain('https://pay.example/c/maria.eth?amount=10')
    expect(body.text).toContain('$10')
  })

  it('send to an UNRESOLVABLE ENS name → honest reply, no link (never a guess)', async () => {
    resolveENS.mockRejectedValue(new EnsResolutionError('no'))
    await POST(update('send 5 to ghost.eth'))
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.text.toLowerCase()).toContain("couldn't find")
    expect(body.text).not.toContain('/c/')
  })

  it('a bare label resolves to its subname checkout without an ENS lookup', async () => {
    await POST(update('send 3 to maria'))
    expect(resolveENS).not.toHaveBeenCalled()
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.text).toContain('https://pay.example/c/maria?amount=3')
  })

  it('enforces the webhook secret when set', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 's3cret'
    const res = await POST(update('help'))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('acks a non-text update without sending', async () => {
    const req = new Request('https://x/api/chat/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { chat: { id: 1 } } }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
