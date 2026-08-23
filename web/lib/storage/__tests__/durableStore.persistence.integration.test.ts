/**
 * durableStore.persistence.integration.test.ts — THE P0.1 PERSISTENCE PROOF.
 *
 * Runs against a REAL Postgres (never a mock): set TEST_DATABASE_URL (see
 * web/docker-compose.dev.yml) or the whole suite skips cleanly — it is excluded
 * from the normal gate by the `*.integration.test.ts` convention and runs via
 * `npm run test:integration`.
 *
 * What this proves (the durable-store release gate, steps 1–3, at the storage
 * layer):
 *   1. RESTART SURVIVAL — a merchant record and a payment-intent record written
 *      through one adapter instance are read back through a SECOND, freshly
 *      constructed instance (its own pg pool). A process restart is, to this
 *      layer, exactly that: the old pool is gone, a new process builds a new
 *      adapter and reads the same rows. (The full app-level restart rehearsal —
 *      systemd restart on staging — is the runbook's step, not this test's.)
 *   2. SECOND-PROCESS VISIBILITY — the second instance is alive WHILE the first
 *      still exists, so the same check also proves cross-process reads.
 *   3. DUPLICATE-EVENT SAFETY — replaying the same write (same namespace+key,
 *      as a re-delivered chain event would) leaves EXACTLY ONE row (the
 *      UNIQUE(namespace,key) upsert), and hydrate() applies each key once.
 *
 * No secret is printed: the connection string comes from the environment and is
 * never logged; failures print pg error MESSAGES only (the adapter's own law).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPostgresKvStore } from '../postgresKvStore.js'
import { __resetDurableKvForTests, getDurableKv, hydrate } from '../durableKv.js'

const URL = process.env.TEST_DATABASE_URL?.trim() ?? ''
const suite = URL ? describe : describe.skip

/** A namespace unique per run so reruns never collide with stale rows. */
const NS = `p01-proof-${process.pid}-${Date.now()}`

suite('P0.1 durable-store persistence proof (real Postgres)', () => {
  const merchant = {
    merchantId: 42,
    slug: 'proof-merchant',
    payout: '0x000000000000000000000000000000000000dEaD',
    brand: { name: 'Proof Merchant', accent: '#0ff' },
  }
  const intent = {
    intentId: '01J-PROOF-INTENT',
    amountUsd8: 1_250_000_000, // $12.50
    status: 'created',
    register: 'reg-1',
  }

  // Instance A — "the first process".
  const storeA = createPostgresKvStore(NS, URL)

  afterAll(async () => {
    // Leave the table clean for the next run (best-effort; row-level only).
    await storeA.delete('merchant:42').catch(() => {})
    await storeA.delete('intent:01J-PROOF-INTENT').catch(() => {})
  })

  beforeAll(async () => {
    await storeA.set('merchant:42', merchant)
    await storeA.set('intent:01J-PROOF-INTENT', intent)
  })

  it('1+2. records survive into a second, freshly-pooled instance (restart/second process)', async () => {
    // Instance B — its own pool, constructed AFTER the writes: the storage-layer
    // equivalent of a restarted (or concurrently running second) process.
    const storeB = createPostgresKvStore(NS, URL)
    expect(await storeB.get('merchant:42')).toEqual(merchant)
    expect(await storeB.get('intent:01J-PROOF-INTENT')).toEqual(intent)
  })

  it('3a. replaying the same event does not duplicate the row', async () => {
    // Re-deliver the intent write twice more, as a duplicate webhook/event would.
    await storeA.set('intent:01J-PROOF-INTENT', intent)
    await storeA.set('intent:01J-PROOF-INTENT', intent)
    const rows = await storeA.entries()
    const intentRows = rows.filter(([k]) => k === 'intent:01J-PROOF-INTENT')
    expect(intentRows).toHaveLength(1)
    expect(rows).toHaveLength(2) // exactly: one merchant + one intent
  })

  it('3b. hydrate() applies each persisted key exactly once', async () => {
    const seen = new Map<string, unknown>()
    __resetDurableKvForTests()
    process.env.NULLIFIER_STORE_URL = URL
    try {
      const applied = await hydrate(NS, (k, v) => {
        expect(seen.has(k)).toBe(false) // no key delivered twice
        seen.set(k, v)
      })
      expect(applied).toBe(2)
      expect(seen.get('merchant:42')).toEqual(merchant)
    } finally {
      delete process.env.NULLIFIER_STORE_URL
      __resetDurableKvForTests()
    }
  })

  it('3c. an update through the seam is a true upsert (latest value wins, still one row)', async () => {
    const paid = { ...intent, status: 'confirmed' }
    await storeA.set('intent:01J-PROOF-INTENT', paid)
    const storeB = createPostgresKvStore(NS, URL)
    expect(await storeB.get('intent:01J-PROOF-INTENT')).toEqual(paid)
    const rows = await storeB.entries()
    expect(rows.filter(([k]) => k.startsWith('intent:'))).toHaveLength(1)
  })

  it('wiring: getDurableKv builds the Postgres backend when the env URL is set', async () => {
    __resetDurableKvForTests()
    process.env.NULLIFIER_STORE_URL = URL
    try {
      const backend = getDurableKv(`${NS}-wiring`)
      expect(backend).not.toBeNull()
      await backend!.set('k', { ok: true })
      expect(await backend!.get('k')).toEqual({ ok: true })
      await backend!.delete('k')
      expect(await backend!.get('k')).toBeUndefined()
    } finally {
      delete process.env.NULLIFIER_STORE_URL
      __resetDurableKvForTests()
    }
  })
})
