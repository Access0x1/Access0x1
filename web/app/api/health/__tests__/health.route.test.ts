/**
 * health.route.test.ts — the P0.2 observability contract: /api/health must tell
 * an operator WHICH build serves and WHETHER persistence is durable, and must
 * never leak an env VALUE while doing it.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { GET } from '../route.js'
import { __resetDurableKvForTests, getDurableKv } from '@/lib/storage/durableKv.js'

/** A healthy fake durable backend for the probe's injected-backend seam. */
const healthyBackend = {
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
  entries: async () => [] as Array<[string, unknown]>,
}
const deadBackend = {
  ...healthyBackend,
  get: async () => {
    throw new Error('connect ECONNREFUSED postgres://user:hunter2@db.internal:5432/ax1')
  },
}

const SAVED = {
  BUILD_ID: process.env.BUILD_ID,
  NEXT_PUBLIC_BUILD_COMMIT: process.env.NEXT_PUBLIC_BUILD_COMMIT,
  NULLIFIER_STORE_URL: process.env.NULLIFIER_STORE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
}

function restore(): void {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetDurableKvForTests()
}

async function body(): Promise<Record<string, unknown>> {
  return (await (await GET()).json()) as Record<string, unknown>
}

afterEach(restore)

describe('GET /api/health', () => {
  it('returns the stable shape with ok/service/apiRoutesReachable', async () => {
    const b = await body()
    expect(b.ok).toBe(true)
    expect(b.service).toBe('access0x1-web')
    expect(b.apiRoutesReachable).toBe(true)
    expect(b.runtime).toBe('nodejs')
    expect(typeof b.commit).toBe('string')
    expect(['postgres', 'postgres-unreachable', 'memory']).toContain(b.store)
  })

  it('commit: BUILD_ID (the EC2 runtime stamp) wins over the build-time fallback', async () => {
    process.env.BUILD_ID = 'abc1234'
    process.env.NEXT_PUBLIC_BUILD_COMMIT = 'ffff999'
    expect((await body()).commit).toBe('abc1234')
  })

  it('commit: falls back to NEXT_PUBLIC_BUILD_COMMIT, then "unknown"', async () => {
    delete process.env.BUILD_ID
    process.env.NEXT_PUBLIC_BUILD_COMMIT = 'ffff999'
    expect((await body()).commit).toBe('ffff999')
    delete process.env.NEXT_PUBLIC_BUILD_COMMIT
    expect((await body()).commit).toBe('unknown')
  })

  it('store: "memory" when no URL; PROBED "postgres" only on a live round-trip', async () => {
    delete process.env.NULLIFIER_STORE_URL
    delete process.env.DATABASE_URL
    __resetDurableKvForTests()
    expect((await body()).store).toBe('memory')

    // A configured URL alone is NOT enough anymore — the probe must succeed.
    process.env.NULLIFIER_STORE_URL = 'postgres://user:hunter2@db.internal:5432/ax1'
    __resetDurableKvForTests()
    getDurableKv('health:probe', healthyBackend)
    expect((await body()).store).toBe('postgres')
  })

  it('store: "postgres-unreachable" when configured but the round-trip fails', async () => {
    process.env.NULLIFIER_STORE_URL = 'postgres://user:hunter2@db.internal:5432/ax1'
    __resetDurableKvForTests()
    getDurableKv('health:probe', deadBackend)
    expect((await body()).store).toBe('postgres-unreachable')
  })

  it('never leaks the connection string — even from a failing probe error', async () => {
    process.env.NULLIFIER_STORE_URL = 'postgres://user:hunter2@db.internal:5432/ax1'
    __resetDurableKvForTests()
    getDurableKv('health:probe', deadBackend) // its error message CONTAINS the URL
    const raw = JSON.stringify(await body())
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('db.internal')
    expect(raw).not.toContain('postgres://')
  })
})
