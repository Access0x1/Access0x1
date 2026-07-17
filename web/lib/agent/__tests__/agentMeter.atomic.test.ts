/**
 * agentMeter.atomic.test.ts — the CROSS-INSTANCE daily cap (money-safety).
 *
 * The sync ledger is pinned on `globalThis`, which shares ONE cap within a process
 * but NOT across Cloud Run instances: each instance boots with an empty ledger, so a
 * per-process check lets N instances EACH spend up to the full cap (the durable
 * write-through was last-write-wins, not an atomic counter). `reserveDailySpend` closes
 * that by reserving against the durable row in ONE atomic op. This suite proves:
 *   (1) a SECOND instance (fresh in-memory ledger, SAME durable row) is rejected once
 *       the SHARED cap is reached — the exact overspend the sync path allowed;
 *   (2) `refundDailySpend` restores the shared durable total (law #5);
 *   (3) with NO atomic backend it FAILS SOFT to the in-memory reserve (unchanged).
 *
 * A fake backend models the `reserveWithinCap` / `decrementClamped` SQL faithfully
 * (single-threaded JS = the DB's single-statement atomicity), so no live Postgres is
 * needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetMeterForTests,
  BudgetExceeded,
  meterSpent,
  refundDailySpend,
  reserveDailySpend,
} from '../agentMeter.js'
import {
  __resetDurableKvForTests,
  getDurableKv,
  type DurableKvStore,
} from '../../storage/durableKv.js'

const today = () => new Date().toISOString().slice(0, 10)

/** Read the `spent` counter a fake backend stores under a day key. */
function spentOf(rows: Map<string, unknown>, key: string): number {
  return (rows.get(key) as { spent?: number } | undefined)?.spent ?? 0
}

/** A plain backend (get/set/delete/entries) with NO atomic ops — the fail-soft case. */
function plainBackend(rows: Map<string, unknown>): DurableKvStore {
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

/** The atomic backend: models the conditional upsert / clamped decrement on the Map. */
function atomicBackend(rows: Map<string, unknown>): DurableKvStore {
  return {
    ...plainBackend(rows),
    async reserveWithinCap(key, delta, cap) {
      const cur = spentOf(rows, key)
      if (delta > cap || cur + delta > cap) return null
      const spent = cur + delta
      rows.set(key, { dayKey: key, spent })
      return spent
    },
    async decrementClamped(key, delta) {
      const spent = Math.max(0, spentOf(rows, key) - delta)
      rows.set(key, { dayKey: key, spent })
      return spent
    },
  }
}

beforeEach(() => {
  __resetMeterForTests()
  __resetDurableKvForTests()
  process.env.AGENT_DAILY_USD_CAP = '5.00'
})

afterEach(() => {
  __resetMeterForTests()
  __resetDurableKvForTests()
})

describe('(1) the shared cap holds across instances', () => {
  it('rejects a second instance once the DURABLE total reaches the cap', async () => {
    const rows = new Map<string, unknown>()
    getDurableKv('agent:meter', atomicBackend(rows))

    // Instance A reserves $4 of the $5 cap.
    await reserveDailySpend(4)
    expect(meterSpent()).toBe(4)
    expect(spentOf(rows, today())).toBe(4)

    // Instance B: a FRESH in-memory ledger (empty), but the SAME durable row.
    __resetMeterForTests()
    expect(meterSpent()).toBe(0) // its local ledger has room…

    // …yet a $4 charge is REJECTED — 4 (shared) + 4 > 5. The sync per-instance
    // check would have ALLOWED this (0 + 4 <= 5) → $8 spent against a $5 cap.
    await expect(reserveDailySpend(4)).rejects.toBeInstanceOf(BudgetExceeded)
    expect(spentOf(rows, today())).toBe(4) // durable unchanged — nothing reserved

    // A charge that fits the REMAINING $1 is accepted, and adopts the shared total.
    await reserveDailySpend(1)
    expect(spentOf(rows, today())).toBe(5)
    expect(meterSpent()).toBe(5)
  })

  it('rejects a single charge above the cap on a fresh day (nothing written)', async () => {
    const rows = new Map<string, unknown>()
    getDurableKv('agent:meter', atomicBackend(rows))
    await expect(reserveDailySpend(6)).rejects.toBeInstanceOf(BudgetExceeded)
    expect(rows.has(today())).toBe(false)
  })
})

describe('(2) durable refund restores the shared total (law #5)', () => {
  it('decrements the durable row and is clamped at zero', async () => {
    const rows = new Map<string, unknown>()
    getDurableKv('agent:meter', atomicBackend(rows))

    await reserveDailySpend(4)
    await refundDailySpend(3)
    expect(spentOf(rows, today())).toBe(1)
    expect(meterSpent()).toBe(1)

    // Over-refund can never drive the shared ledger negative.
    await refundDailySpend(10)
    expect(spentOf(rows, today())).toBe(0)
    expect(meterSpent()).toBe(0)
  })
})

describe('(3) fail-soft: no atomic backend falls back to the in-memory reserve', () => {
  it('reserves against the in-memory ledger and write-throughs when the backend lacks atomics', async () => {
    const rows = new Map<string, unknown>()
    getDurableKv('agent:meter', plainBackend(rows)) // no reserveWithinCap/decrementClamped

    await reserveDailySpend(2)
    expect(meterSpent()).toBe(2)
    // The non-atomic path still write-throughs the running total for hydration.
    expect(spentOf(rows, today())).toBe(2)

    // The per-instance ceiling still rejects an over-cap charge.
    await expect(reserveDailySpend(4)).rejects.toBeInstanceOf(BudgetExceeded)
    expect(meterSpent()).toBe(2)
  })
})
