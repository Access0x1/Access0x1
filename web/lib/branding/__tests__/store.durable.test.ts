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
  sanitizePriceUsd,
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

describe('priceUsd — a link never charges a number the merchant did not choose', () => {
  // The bug this pins: the done-screen link and embed hardcoded 29.00, and no field
  // existed anywhere in the product to change it. A merchant selling a $25 haircut
  // handed out a QR that charged $29.
  it('normalizes a typed price to two decimals', () => {
    expect(sanitizePriceUsd('25')).toBe('25.00')
    expect(sanitizePriceUsd('25.5')).toBe('25.50')
    expect(sanitizePriceUsd(12.345)).toBe('12.35')
  })

  it('treats junk as NO PRICE rather than coercing it to something', () => {
    // Every one of these would previously have been papered over by the 29.00
    // fallback. "No price set" is a state the checkout can state honestly; a
    // silently-invented price is a wrong charge.
    for (const bad of ['', '   ', 'abc', '0', '-5', 'NaN', 'Infinity', null, undefined]) {
      expect(sanitizePriceUsd(bad)).toBeNull()
    }
  })

  it('rejects an absurd price instead of putting it in a customer-facing link', () => {
    expect(sanitizePriceUsd('1000001')).toBeNull()
  })

  it('persists the price and leaves it alone when a later write omits it', () => {
    const tenantId = '0x' + 'a'.repeat(40)
    upsertBranding({ tenantId, displayName: 'Joe', priceUsd: '25' })
    expect(getByTenant(tenantId)?.priceUsd).toBe('25.00')

    // An edit that only changes the description must not silently clear the price.
    upsertBranding({ tenantId, displayName: 'Joe', description: 'Cuts' })
    expect(getByTenant(tenantId)?.priceUsd).toBe('25.00')

    // An explicit null DOES clear it — "no price" has to be expressible.
    upsertBranding({ tenantId, displayName: 'Joe', priceUsd: null })
    expect(getByTenant(tenantId)?.priceUsd).toBeNull()
  })
})
