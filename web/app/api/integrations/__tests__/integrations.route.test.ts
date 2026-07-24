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

  it('counts demo readiness out of the demo-impact integrations', async () => {
    const body = await (await get()).json()
    expect(body.demoReadiness.total).toBeGreaterThan(0)
    expect(body.demoReadiness.ready).toBeLessThanOrEqual(body.demoReadiness.total)
  })
})
