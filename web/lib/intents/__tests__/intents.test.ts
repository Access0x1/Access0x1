/**
 * intents.test.ts — P0.3 unit contract: ULID properties, the bytes32 orderId
 * bridge, and the store's create/read/lazy-expiry semantics (with the durable
 * write-through observed through the injected-backend seam).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __resetDurableKvForTests, getDurableKv, type DurableKvStore } from '../../storage/durableKv.js'
import { __resetUlidForTests, ULID_REGEX, ulid } from '../ulid.js'
import { intentIdToOrderId, orderIdToIntentId, toPublicIntent } from '../types.js'
import {
  __resetIntentsForTests,
  createIntent,
  DEFAULT_INTENT_TTL_MS,
  getIntent,
} from '../store.js'

/** A recording fake durable backend, injected under the intents namespace. */
function recordingBackend(): DurableKvStore & { writes: Array<[string, unknown]> } {
  const writes: Array<[string, unknown]> = []
  return {
    writes,
    get: async () => undefined,
    set: async (key, value) => {
      writes.push([key, value])
    },
    delete: async () => undefined,
    entries: async () => [],
  }
}

const T0 = 1_800_000_000_000 // a fixed, deterministic "now"

const BASE = {
  tenantId: 'tenant-1',
  merchantId: 42,
  slug: 'proof-merchant',
  amountUsd8: 12_50_000_000, // $12.50
  chainId: 84532,
}

beforeEach(() => {
  __resetIntentsForTests()
  __resetUlidForTests()
  __resetDurableKvForTests()
})
afterEach(() => {
  __resetIntentsForTests()
  __resetDurableKvForTests()
})

describe('ulid', () => {
  it('emits canonical 26-char Crockford ULIDs, unique across a burst', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const id = ulid()
      expect(id).toMatch(ULID_REGEX)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })

  it('same-ms ids stay strictly ascending (monotonic increment)', () => {
    const a = ulid(T0)
    const b = ulid(T0)
    const c = ulid(T0)
    expect(b > a).toBe(true)
    expect(c > b).toBe(true)
  })

  it('later timestamps always sort after earlier ones', () => {
    const early = ulid(T0)
    const late = ulid(T0 + 1)
    expect(late > early).toBe(true)
  })
})

describe('the bytes32 orderId bridge', () => {
  it('round-trips an intent id through payToken orderId encoding', () => {
    const id = ulid(T0)
    const orderId = intentIdToOrderId(id)
    expect(orderId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(orderIdToIntentId(orderId)).toBe(id)
  })

  it('rejects non-ULID input loudly at encode time', () => {
    expect(() => intentIdToOrderId('not-a-ulid')).toThrow(/not a canonical ULID/)
  })

  it('decodes garbage orderIds to null (an unmatched but valid payment)', () => {
    expect(orderIdToIntentId('0x' + 'ff'.repeat(32))).toBeNull()
    expect(orderIdToIntentId('0x1234')).toBeNull()
    // canonical ascii but tampered padding is NOT canonical
    const id = ulid(T0)
    const tampered = intentIdToOrderId(id).slice(0, -1) + '1'
    expect(orderIdToIntentId(tampered)).toBeNull()
  })
})

describe('intent store', () => {
  it('creates, persists via write-through, and reads back', () => {
    const backend = recordingBackend()
    getDurableKv('intents:v1', backend)
    const intent = createIntent(BASE, T0)
    expect(intent.status).toBe('created')
    expect(intent.expiresAt).toBe(T0 + DEFAULT_INTENT_TTL_MS)
    expect(getIntent(intent.intentId, T0 + 1000)).toEqual(intent)
    expect(backend.writes).toHaveLength(1)
    expect(backend.writes[0][0]).toBe(intent.intentId)
  })

  it('lazy expiry: the first read past the deadline flips and persists expired', () => {
    const backend = recordingBackend()
    getDurableKv('intents:v1', backend)
    const intent = createIntent(BASE, T0)
    const after = getIntent(intent.intentId, T0 + DEFAULT_INTENT_TTL_MS + 1)
    expect(after?.status).toBe('expired')
    // one write for create, one for the expiry flip — and re-reads add nothing
    getIntent(intent.intentId, T0 + DEFAULT_INTENT_TTL_MS + 2000)
    expect(backend.writes).toHaveLength(2)
    expect((backend.writes[1][1] as { status: string }).status).toBe('expired')
  })

  it('bounds are enforced loudly at create', () => {
    expect(() => createIntent({ ...BASE, amountUsd8: 0 }, T0)).toThrow(/amountUsd8/)
    expect(() => createIntent({ ...BASE, amountUsd8: 1.5 }, T0)).toThrow(/amountUsd8/)
    expect(() => createIntent({ ...BASE, chainId: -1 }, T0)).toThrow(/chainId/)
    expect(() => createIntent({ ...BASE, note: 'x'.repeat(201) }, T0)).toThrow(/note/)
    expect(() => createIntent({ ...BASE, ttlMs: 0 }, T0)).toThrow(/ttlMs/)
  })

  it('the public projection never leaks tenant, register, or the note', () => {
    const intent = createIntent(
      { ...BASE, registerId: 'reg-1', note: 'private cashier note' },
      T0,
    )
    const pub = toPublicIntent(intent)
    const raw = JSON.stringify(pub)
    expect(raw).not.toContain('tenant-1')
    expect(raw).not.toContain('reg-1')
    expect(raw).not.toContain('private cashier note')
    expect(pub.intentId).toBe(intent.intentId)
    expect(pub.amountUsd8).toBe(BASE.amountUsd8)
  })
})
