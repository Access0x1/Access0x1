/**
 * apiKeys.durable.test.ts — API-key registry durability. Proves:
 *   (a) with NO durable backend, register/resolve works as before (fail-soft);
 *   (b) when configured, registration mirrors to the durable backend (HASH +
 *       binding only, never the plaintext key) and `hydrateApiKeysFromDurable`
 *       restores it into a wiped registry — an issued key survives scale-to-zero;
 *   (c) the bigint per-call price round-trips through JSON (decimal-string encoding).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetApiKeysForTests,
  hydrateApiKeysFromDurable,
  registerKey,
  resolveKey,
  type KeyBinding,
} from '../apiKeys.js'
import type { SessionId } from '../sessionMeter.js'
import {
  __resetDurableKvForTests,
  getDurableKv,
  type DurableKvStore,
} from '../../storage/durableKv.js'

const SID = ('0x' + '3'.repeat(64)) as SessionId
const KEY = 'ak_live_demo_0123456789abcdef'
const BINDING: KeyBinding = { sessionId: SID, pricePerCallAtomic: 1000n, label: 'demo' }

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
  __resetApiKeysForTests()
  __resetDurableKvForTests()
})

afterEach(() => {
  __resetApiKeysForTests()
  __resetDurableKvForTests()
})

describe('(a) in-memory path works with no durable backend', () => {
  it('registers and resolves a key', () => {
    registerKey(KEY, BINDING)
    expect(resolveKey(KEY)).toEqual(BINDING)
  })
})

describe('(b)(c) durable write-through survives a scale-to-zero', () => {
  it('persists only the hash + binding, and round-trips the bigint price', async () => {
    const rows = new Map<string, unknown>()
    getDurableKv('ai:apiKey', fakeBackend(rows))

    registerKey(KEY, BINDING)
    await Promise.resolve()
    expect(rows.size).toBe(1)
    // The durable row must NOT contain the plaintext key anywhere.
    const persisted = JSON.stringify([...rows.values()])
    expect(persisted).not.toContain(KEY)
    // The price is a decimal STRING in the durable form (JSON can't hold bigint).
    expect(persisted).toContain('"1000"')

    // --- scale-to-zero ---
    __resetApiKeysForTests()
    __resetDurableKvForTests()
    expect(resolveKey(KEY)).toBeNull()

    getDurableKv('ai:apiKey', fakeBackend(rows))
    const restored = await hydrateApiKeysFromDurable()
    expect(restored).toBe(1)
    const binding = resolveKey(KEY)
    expect(binding).toEqual(BINDING)
    expect(binding?.pricePerCallAtomic).toBe(1000n) // bigint preserved exactly
  })
})
