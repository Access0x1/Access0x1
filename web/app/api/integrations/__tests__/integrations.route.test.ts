/**
 * integrations.route.test.ts — the public config-status endpoint.
 *
 * The load-bearing assertion is the LEAK test: this route reports on every
 * credential the app uses, so the one thing it must never do is let a value out.
 * The rest pins the contract a dashboard would depend on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { GET } = await import('../route.js')

afterEach(() => {
  vi.unstubAllEnvs()
})

const get = (): Promise<Response> => GET() as unknown as Promise<Response>

describe('GET /api/integrations', () => {
  it('never leaks a configured VALUE, only names and booleans', async () => {
    const secret = 'sk-ant-super-secret-do-not-leak'
    vi.stubEnv('CLAUDE_API_KEY', secret)
    vi.stubEnv('NAMESTONE_API_KEY', 'namestone-secret-value')

    const body = await (await get()).text()
    expect(body).not.toContain(secret)
    expect(body).not.toContain('namestone-secret-value')
    // Not even a prefix or fingerprint of the value.
    expect(body).not.toContain('sk-ant')
  })

  it('is always 200 — an unconfigured app is working, not broken', async () => {
    const res = await get()
    expect(res.status).toBe(200)
  })

  it('is never cached (live operator state)', async () => {
    expect((await get()).headers.get('cache-control')).toContain('no-store')
  })

  it('reports a configured integration as configured', async () => {
    vi.stubEnv('CLAUDE_API_KEY', 'anything-non-empty')
    const body = await (await get()).json()
    const claude = body.integrations.find((i: { id: string }) => i.id === 'anthropic')
    expect(claude.state).toBe('configured')
    expect(claude.ready).toBe(true)
  })

  it('surfaces the dangerous PARTIAL state separately', async () => {
    // Key set, URL missing — looks on, would never work.
    vi.stubEnv('UNISWAP_TRADING_API_KEY', 'k')
    vi.stubEnv('UNISWAP_TRADING_API_URL', '')
    const body = await (await get()).json()
    expect(body.partial).toContain('uniswap')
  })

  it('names the secret vars without implying their values are available', async () => {
    const body = await (await get()).json()
    const claude = body.integrations.find((i: { id: string }) => i.id === 'anthropic')
    expect(claude.secretVars).toContain('CLAUDE_API_KEY')
  })

  it('counts live readiness out of the core-impact integrations', async () => {
    const body = await (await get()).json()
    expect(body.liveReadiness.total).toBeGreaterThan(0)
    expect(body.liveReadiness.ready).toBeLessThanOrEqual(body.liveReadiness.total)
  })

  it('surfaces placeholder vars by name — the state that lies to a dashboard', async () => {
    vi.stubEnv('CLAUDE_API_KEY', '⟨PASTE your key⟩')
    const body = await (await get()).json()
    const hit = body.placeholders.find((p: { id: string }) => p.id === 'anthropic')
    expect(hit?.vars).toContain('CLAUDE_API_KEY')
    // Still never the value itself.
    expect(JSON.stringify(body)).not.toContain('PASTE your key')
  })

  it('reports no placeholders when nothing is scaffolded', async () => {
    vi.stubEnv('CLAUDE_API_KEY', 'sk-ant-a-real-looking-value')
    const body = await (await get()).json()
    const hit = body.placeholders.find((p: { id: string }) => p.id === 'anthropic')
    expect(hit).toBeUndefined()
  })
})
