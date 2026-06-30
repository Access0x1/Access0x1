/**
 * replayStore.test.ts — the durable replay store + fail-closed factory (R-2).
 *
 * Pins the four properties the audit fix must guarantee:
 *   (a) REPLAY across a restart is rejected — a SECOND Postgres-adapter instance
 *       built over the SAME backing rows (simulating a process restart) still sees
 *       the spent key and refuses the re-claim;
 *   (b) the atomic claim returns true EXACTLY ONCE for one `(namespace, key)`;
 *   (c) PRODUCTION fails closed — unconfigured + production/required → throws
 *       DurableStoreRequiredError (the route maps it to 503);
 *   (d) DEV falls back to the in-memory store with a LOUD console warning.
 *
 * `pg` is never required: the Postgres adapter is driven by a FAKE in-test pool
 * that models the `UNIQUE(namespace, key)` table, so there is no live DB. Env is
 * mutated via `vi.stubEnv` (auto-restored), since `NODE_ENV` is read-only-typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DurableStoreRequiredError,
  __resetReplayStoreForTests,
  durableStoreRequired,
  getReplayStore,
  isDurableStoreConfigured,
} from '../replayStore.js'
import {
  createPostgresReplayStore,
  REPLAY_CLAIMS_DDL,
} from '../postgresReplayStore.js'
import { __resetMemoryReplayStore } from '../memoryReplayStore.js'

/**
 * A fake `pg` Pool backed by a Set of `${namespace} ${key}` rows — a faithful
 * stand-in for a real `UNIQUE(namespace, key)` table. Multiple adapter instances
 * can share ONE backing Set to simulate a durable DB surviving a "restart".
 */
function fakePool(backing: Set<string>, ddlSeen: { value: boolean }) {
  return {
    async query(text: string, values?: unknown[]) {
      if (/create table/i.test(text)) {
        ddlSeen.value = true
        return { rowCount: 0 }
      }
      const [namespace, key] = (values ?? []) as string[]
      const rowKey = `${namespace} ${key}`
      if (/^\s*insert/i.test(text)) {
        // INSERT ... ON CONFLICT DO NOTHING RETURNING 1 → 1 row iff fresh.
        if (backing.has(rowKey)) return { rowCount: 0 }
        backing.add(rowKey)
        return { rowCount: 1 }
      }
      // SELECT 1 ... LIMIT 1 → present?
      return { rowCount: backing.has(rowKey) ? 1 : 0 }
    },
  }
}

beforeEach(() => {
  __resetReplayStoreForTests()
  __resetMemoryReplayStore()
  // Start every case from a clean, unconfigured, non-prod baseline.
  vi.stubEnv('NULLIFIER_STORE_URL', '')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('VERIFY_REQUIRE_DURABLE_STORE', '')
  vi.stubEnv('NODE_ENV', 'test')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  __resetReplayStoreForTests()
})

describe('Postgres durable adapter — atomic, idempotent, replay-proof', () => {
  it('(b) claim returns true EXACTLY ONCE for the same (namespace, key)', async () => {
    const backing = new Set<string>()
    const ddl = { value: false }
    const store = createPostgresReplayStore('postgres://test', fakePool(backing, ddl))

    expect(await store.claim('worldid:act', '123')).toBe(true) // first wins
    expect(await store.claim('worldid:act', '123')).toBe(false) // replay loses
    expect(await store.claim('worldid:act', '123')).toBe(false) // still a replay
    expect(await store.has('worldid:act', '123')).toBe(true)
    // The schema DDL ran (CREATE TABLE IF NOT EXISTS), so an operator needn't
    // hand-migrate for the gate to work.
    expect(ddl.value).toBe(true)
    expect(REPLAY_CLAIMS_DDL).toMatch(/UNIQUE\s*\(namespace,\s*key\)/)
  })

  it('scopes by namespace — same key under a different namespace is fresh', async () => {
    const backing = new Set<string>()
    const store = createPostgresReplayStore('postgres://test', fakePool(backing, { value: false }))
    expect(await store.claim('worldid:a', '0x10')).toBe(true)
    expect(await store.claim('worldid:b', '0x10')).toBe(true) // different action → fresh
    expect(await store.claim('oidc:iss', '0x10')).toBe(true) // different gate → fresh
  })

  it('(a) REPLAY across a simulated restart is rejected (new instance, same rows)', async () => {
    // One backing Set = the durable Postgres table. The first adapter "process"
    // claims the key; a SECOND adapter instance over the SAME rows = a restart.
    const durableRows = new Set<string>()

    const beforeRestart = createPostgresReplayStore('postgres://test', fakePool(durableRows, { value: false }))
    expect(await beforeRestart.claim('worldid:act', 'nullifier-xyz')).toBe(true)

    // --- process restart: brand-new store object, in-memory caches gone, but the
    // durable rows persist (that is exactly what the in-memory store FAILED at) ---
    const afterRestart = createPostgresReplayStore('postgres://test', fakePool(durableRows, { value: false }))
    expect(await afterRestart.has('worldid:act', 'nullifier-xyz')).toBe(true)
    expect(await afterRestart.claim('worldid:act', 'nullifier-xyz')).toBe(false) // replay refused
  })
})

describe('factory — production fail-closed (c) / dev fallback (d)', () => {
  it('selects the durable Postgres store when a URL is configured', () => {
    vi.stubEnv('NULLIFIER_STORE_URL', 'postgres://configured')
    expect(isDurableStoreConfigured()).toBe(true)
    // Does NOT throw, and is not the in-memory store. (We can't claim without a
    // live DB here; the adapter wiring is proven by the Postgres tests above.)
    expect(() => getReplayStore()).not.toThrow()
  })

  it('falls back to DATABASE_URL when NULLIFIER_STORE_URL is unset', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fallback')
    expect(isDurableStoreConfigured()).toBe(true)
    expect(() => getReplayStore()).not.toThrow()
  })

  it('(c) FAILS CLOSED in production when no durable store is configured', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(durableStoreRequired()).toBe(true)
    expect(isDurableStoreConfigured()).toBe(false)
    expect(() => getReplayStore()).toThrow(DurableStoreRequiredError)
  })

  it('(c) FAILS CLOSED when VERIFY_REQUIRE_DURABLE_STORE=true (non-prod) and unconfigured', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('VERIFY_REQUIRE_DURABLE_STORE', 'true')
    expect(durableStoreRequired()).toBe(true)
    expect(() => getReplayStore()).toThrow(DurableStoreRequiredError)
  })

  it('(c) production WITH a durable URL does NOT fail closed', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NULLIFIER_STORE_URL', 'postgres://prod')
    expect(() => getReplayStore()).not.toThrow()
  })

  it('(d) DEV falls back to the in-memory store with a LOUD warning', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(durableStoreRequired()).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = getReplayStore()
    // It works as a replay store…
    expect(await store.claim('worldid:act', 'k1')).toBe(true)
    expect(await store.claim('worldid:act', 'k1')).toBe(false)
    // …and it warned loudly that this is dev-only / replay-vulnerable.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/in-memory|replay/i)
  })

  it('the in-memory dev store LOSES its claims on a restart (proves why R-2 mattered)', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = getReplayStore()
    expect(await store.claim('worldid:act', 'k2')).toBe(true)

    // Simulate a restart: wipe the pinned in-memory set + drop the cached store.
    __resetMemoryReplayStore()
    __resetReplayStoreForTests()

    const afterRestart = getReplayStore()
    // The "spent" key is GONE — re-claim succeeds. This is the replay hole the
    // durable Postgres store closes.
    expect(await afterRestart.claim('worldid:act', 'k2')).toBe(true)
  })
})
