/**
 * agentMeter.durable.test.ts — daily spend meter durability. Proves:
 *   (a) with NO durable backend the meter works as before (fail-soft);
 *   (b) when configured, a spend write-throughs the day's running total, and
 *       `hydrateMeterFromDurable` restores it into a wiped ledger — so a restart
 *       mid-day RESUMES the cap instead of resetting spend to zero (which would let
 *       the agent overspend its daily budget);
 *   (c) hydration is monotone — it never rolls an already-advanced in-memory ledger
 *       BACKWARD (takes the max of memory vs durable).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetMeterForTests,
  hydrateMeterFromDurable,
  meterSpendOrThrow,
  meterSpent,
} from '../agentMeter.js'
import {
  __resetDurableKvForTests,
  getDurableKv,
  type DurableKvStore,
} from '../../storage/durableKv.js'

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

const today = () => new Date().toISOString().slice(0, 10)

beforeEach(() => {
  __resetMeterForTests()
  __resetDurableKvForTests()
  process.env.AGENT_DAILY_USD_CAP = '5.00'
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
  __resetMeterForTests()
  __resetDurableKvForTests()
})

describe('(a) in-memory path works with no durable backend', () => {
  it('accumulates spend within the day', () => {
    meterSpendOrThrow(1)
    meterSpendOrThrow(2)
    expect(meterSpent()).toBe(3)
  })
})

describe("(b) durable write-through resumes the day's cap after a restart", () => {
  it('restores the spent total from the durable backend', async () => {
    const rows = new Map<string, unknown>()
    getDurableKv('agent:meter', fakeBackend(rows))

    meterSpendOrThrow(3)
    await Promise.resolve()
    // today's row holds the running total
    expect(rows.get(today())).toMatchObject({ spent: 3 })

    // --- restart mid-day: in-memory ledger wiped, durable row persists ---
    __resetMeterForTests()
    __resetDurableKvForTests()
    expect(meterSpent()).toBe(0) // memory reset to zero

    getDurableKv('agent:meter', fakeBackend(rows))
    await hydrateMeterFromDurable()
    expect(meterSpent()).toBe(3) // the cap RESUMES — no free reset
  })

  it('(c) hydration never rolls an advanced in-memory ledger backward', async () => {
    const rows = new Map<string, unknown>()
    // Durable says 1 was spent today.
    rows.set(today(), { dayKey: today(), spent: 1 })
    getDurableKv('agent:meter', fakeBackend(rows))

    // But this process already advanced to 4 in memory.
    meterSpendOrThrow(4)
    await hydrateMeterFromDurable()
    expect(meterSpent()).toBe(4) // max(4, 1) — not pulled down to 1
  })

  it("ignores a stale prior-day durable row (the meter resets on the day boundary)", async () => {
    const rows = new Map<string, unknown>()
    rows.set('2000-01-01', { dayKey: '2000-01-01', spent: 99 })
    getDurableKv('agent:meter', fakeBackend(rows))
    await hydrateMeterFromDurable()
    expect(meterSpent()).toBe(0) // yesterday's spend does not bleed into today
  })
})
