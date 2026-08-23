/**
 * intents.persistence.integration.test.ts — the P0.3 half of the durable-store
 * release gate, against a REAL Postgres (web/docker-compose.dev.yml):
 * an intent created through the store survives into a fresh adapter instance
 * (the storage-layer restart), and replayed writes stay single-row. Runs only
 * under `VITEST_INTEGRATION=1` with TEST_DATABASE_URL set; skips cleanly
 * otherwise (same convention as durableStore.persistence.integration.test.ts).
 */
import { afterAll, describe, expect, it } from 'vitest'

import { createPostgresKvStore } from '../../storage/postgresKvStore.js'
import { __resetDurableKvForTests, getDurableKv } from '../../storage/durableKv.js'
import { __resetIntentsForTests, createIntent } from '../store.js'

const URL = process.env.TEST_DATABASE_URL?.trim() ?? ''
const suite = URL ? describe : describe.skip

const NS = 'intents:v1'

suite('P0.3 intent persistence (real Postgres)', () => {
  afterAll(async () => {
    __resetIntentsForTests()
    __resetDurableKvForTests()
  })

  it('an intent created through the store survives into a fresh adapter instance', async () => {
    __resetDurableKvForTests()
    process.env.NULLIFIER_STORE_URL = URL
    try {
      // Route the store's write-through at the REAL adapter (instance A).
      const a = createPostgresKvStore(NS, URL)
      getDurableKv(NS, a)
      const intent = createIntent({
        tenantId: `tenant-int-${process.pid}`,
        merchantId: 42,
        slug: 'proof-merchant',
        amountUsd8: 1_250_000_000,
        chainId: 84532,
      })
      // durableSet is fire-and-forget; give the write a beat, then read it back
      // through instance B — a fresh pool, the storage-layer "other process".
      await new Promise((r) => setTimeout(r, 250))
      const b = createPostgresKvStore(NS, URL)
      const row = (await b.get(intent.intentId)) as { intentId: string; status: string }
      expect(row?.intentId).toBe(intent.intentId)
      expect(row?.status).toBe('created')

      // Replay the same row twice — still exactly one copy under this key.
      await a.set(intent.intentId, row)
      await a.set(intent.intentId, row)
      const rows = await b.entries()
      expect(rows.filter(([k]) => k === intent.intentId)).toHaveLength(1)

      await a.delete(intent.intentId)
    } finally {
      delete process.env.NULLIFIER_STORE_URL
      __resetDurableKvForTests()
    }
  })
})
