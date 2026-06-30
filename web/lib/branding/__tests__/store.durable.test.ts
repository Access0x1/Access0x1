/**
 * store.durable.test.ts — branding store durability (the highest-value half of the
 * scale-to-zero fix). Proves:
 *   (a) with NO durable backend the in-memory store works EXACTLY as before
 *       (upsert + read by tenant/slug/merchant) — fail-soft, no behaviour change;
 *   (b) when a durable backend is configured, `upsertBranding` write-throughs the
 *       row, and `hydrateBrandingFromDurable` restores it (+ its slug/merchant
 *       indexes) into a wiped in-memory store — i.e. a tenant's checkout identity
 *       SURVIVES a Cloud Run scale-to-zero.
 *
 * No live DB: a fake `DurableKvStore` backs the write-through via the injected seam.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetBrandingStore,
  attachOnChain,
  getByMerchantId,
  getBySlug,
  getByTenant,
  hydrateBrandingFromDurable,
  upsertBranding,
} from '../store.js'
import {
  __resetDurableKvForTests,
  getDurableKv,
  type DurableKvStore,
} from '../../storage/durableKv.js'

/** A fake durable backend backed by a Map, shared across "restarts". */
function fakeBackend(rows: Map<string, unknown>): DurableKvStore {
  return {
    async get(key) {
      return rows.get(key)
    },
    async set(key, value) {
      rows.set(key, value)
    },
    async delete(key) {
      rows.delete(key)
    },
    async entries() {
      return [...rows.entries()]
    },
  }
}

beforeEach(() => {
  __resetBrandingStore()
  __resetDurableKvForTests()
})

afterEach(() => {
  __resetBrandingStore()
  __resetDurableKvForTests()
})

describe('(a) in-memory path works with no durable backend', () => {
  it('upserts and reads by tenant / slug / merchant', () => {
    const row = upsertBranding({ tenantId: 't1', displayName: 'Joe Barbershop' })
    expect(getByTenant('t1')?.displayName).toBe('Joe Barbershop')
    expect(getBySlug(row.checkoutSlug)?.tenantId).toBe('t1')
    const withMerchant = attachOnChain('t1', { merchantId: 'm-1' })
    expect(withMerchant?.merchantId).toBe('m-1')
    expect(getByMerchantId('m-1')?.tenantId).toBe('t1')
  })
})

describe('(b) durable write-through survives a scale-to-zero', () => {
  it('hydrates a wiped store from the durable backend, indexes intact', async () => {
    const rows = new Map<string, unknown>()
    // Wire the durable seam BEFORE the write so upsert mirrors through.
    getDurableKv('branding:tenant', fakeBackend(rows))

    const row = upsertBranding({
      tenantId: 't1',
      displayName: 'Joe Barbershop',
      checkoutSlug: 'joe',
    })
    attachOnChain('t1', { merchantId: 'm-1' })
    // The durable backend now holds the row (write-through is fire-and-forget).
    await Promise.resolve()
    expect(rows.size).toBe(1)

    // --- scale-to-zero: wipe the in-memory store (durable rows persist) ---
    __resetBrandingStore()
    __resetDurableKvForTests()
    expect(getByTenant('t1')).toBeNull() // memory is empty after the "restart"

    // Re-wire the same durable rows + hydrate, as the module does at boot.
    getDurableKv('branding:tenant', fakeBackend(rows))
    const restored = await hydrateBrandingFromDurable()
    expect(restored).toBe(1)

    // The tenant's full identity is back — by tenant, slug, AND merchant index.
    expect(getByTenant('t1')?.displayName).toBe('Joe Barbershop')
    expect(getBySlug('joe')?.tenantId).toBe('t1')
    expect(getByMerchantId('m-1')?.tenantId).toBe('t1')
    expect(getByTenant('t1')?.checkoutSlug).toBe(row.checkoutSlug)
  })
})
