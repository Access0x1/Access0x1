/**
 * store.durable.test.ts — verification profile store durability. Proves:
 *   (a) with NO durable backend, add/get user + agent methods work as before;
 *   (b) when configured, writes mirror to the durable backend and
 *       `hydrateVerificationFromDurable` restores BOTH keyspaces (user + agent)
 *       into a wiped store — earned verification methods survive scale-to-zero.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetVerificationStore,
  addAgentMethod,
  addMethod,
  getAgentProfile,
  getProfile,
  hydrateVerificationFromDurable,
} from '../store.js'
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

const USER = '0x' + 'a'.repeat(40)
const AGENT = '0x' + 'b'.repeat(64)

beforeEach(() => {
  __resetVerificationStore()
  __resetDurableKvForTests()
})

afterEach(() => {
  __resetVerificationStore()
  __resetDurableKvForTests()
})

describe('(a) in-memory path works with no durable backend', () => {
  it('records and reads user + agent methods', () => {
    addMethod(USER, 'world-id')
    addAgentMethod(AGENT, 'oidc')
    expect(getProfile(USER).methods).toContain('world-id')
    expect(getAgentProfile(AGENT).methods).toContain('oidc')
  })
})

describe('(b) durable write-through survives a scale-to-zero', () => {
  it('hydrates BOTH user and agent profiles from the durable backend', async () => {
    const rows = new Map<string, unknown>()
    getDurableKv('verification:profile', fakeBackend(rows))

    addMethod(USER, 'world-id')
    addAgentMethod(AGENT, 'oidc')
    await Promise.resolve()
    // one user row + one agent row, distinct durable keys
    expect(rows.size).toBe(2)

    // --- scale-to-zero ---
    __resetVerificationStore()
    __resetDurableKvForTests()
    expect(getProfile(USER).methods).toEqual([])
    expect(getAgentProfile(AGENT).methods).toEqual([])

    getDurableKv('verification:profile', fakeBackend(rows))
    const restored = await hydrateVerificationFromDurable()
    expect(restored).toBe(2)
    expect(getProfile(USER).methods).toContain('world-id')
    expect(getAgentProfile(AGENT).methods).toContain('oidc')
  })
})
