/**
 * status.route.test.ts — GET /api/world/status.
 *
 * The route exists so a dormant seam can be diagnosed instead of guessed at. Two
 * properties matter and both are pinned here: a dormant seam is a 200 with a
 * verdict (not an error — the seam failing soft is normal), and the body carries
 * variable NAMES and booleans but never a credential value.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ENV_KEYS = [
  'NEXT_PUBLIC_WORLD_APP_ID',
  'WORLD_RP_ID',
  'WORLD_SIGNING_KEY',
  'NULLIFIER_STORE_URL',
  'DATABASE_URL',
  'VERIFY_REQUIRE_DURABLE_STORE',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function get(): Promise<Response> {
  const { GET } = await import('../status/route.js')
  return GET()
}

describe('GET /api/world/status', () => {
  it('answers 200 with the honest label while the seam is dormant', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ready: boolean; label: string; missing: string[] }
    expect(body.ready).toBe(false)
    expect(body.label).toBe('built, env-gated')
    expect(body.missing).toContain('WORLD_SIGNING_KEY')
  })

  it('is never cached — readiness changes the moment env is wired', async () => {
    expect((await get()).headers.get('Cache-Control')).toBe('no-store')
  })

  it('tops out at "configured, unverified" once every requirement is present', async () => {
    process.env.NEXT_PUBLIC_WORLD_APP_ID = 'app_x'
    process.env.WORLD_RP_ID = 'rp_x'
    process.env.WORLD_SIGNING_KEY = '0xk'
    process.env.NULLIFIER_STORE_URL = 'postgres://u:p@h:5432/d'
    const body = (await (await get()).json()) as { ready: boolean; label: string }
    expect(body.ready).toBe(true)
    // The route reports CONFIGURATION, never a completed verify — so "live" is a
    // word no env read can earn here (law #4).
    expect(body.label).toBe('configured, unverified')
  })

  it('never serves a credential value over HTTP', async () => {
    process.env.NEXT_PUBLIC_WORLD_APP_ID = 'app_x'
    process.env.WORLD_RP_ID = 'rp_x'
    process.env.WORLD_SIGNING_KEY = '0xKEYSHOULDNEVERAPPEAR'
    process.env.NULLIFIER_STORE_URL = 'postgres://u:PWSHOULDNEVERAPPEAR@h:5432/d'
    const raw = await (await get()).text()
    expect(raw).not.toContain('KEYSHOULDNEVERAPPEAR')
    expect(raw).not.toContain('PWSHOULDNEVERAPPEAR')
  })
})
