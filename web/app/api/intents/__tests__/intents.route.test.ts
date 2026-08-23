/**
 * intents.route.test.ts — the API edge of P0.3: auth policy on create,
 * validation 400s, the 201 shape, and the public GET's narrow projection
 * (404 / expired behavior included).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { POST } from '../route.js'
import { GET } from '../[id]/route.js'
import { __resetIntentsForTests, createIntent } from '@/lib/intents/store.js'
import { __resetDurableKvForTests } from '@/lib/storage/durableKv.js'

const SAVED = {
  BRANDING_REQUIRE_VERIFIED_WRITES: process.env.BRANDING_REQUIRE_VERIFIED_WRITES,
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://test.local/api/intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function getById(id: string): Promise<Response> {
  return GET(new Request(`http://test.local/api/intents/${id}`), {
    params: Promise.resolve({ id }),
  })
}

const VALID = {
  tenantId: '0x' + 'ab'.repeat(20), // wallet-shaped: the body-fallback tenant form
  merchantId: 42,
  slug: 'proof-merchant',
  amountUsd8: 500_000_000, // $5
  chainId: 84532,
}

beforeEach(() => {
  __resetIntentsForTests()
  __resetDurableKvForTests()
  // Dev-policy path: unverified writes allowed, tenant resolved from the body —
  // the verified-JWT path is the branding tenant module's own tested concern.
  process.env.BRANDING_REQUIRE_VERIFIED_WRITES = 'false'
})
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetIntentsForTests()
  __resetDurableKvForTests()
})

describe('POST /api/intents', () => {
  it('401s when the verified-write policy is on and no identity is provable', async () => {
    process.env.BRANDING_REQUIRE_VERIFIED_WRITES = 'true'
    const res = await post(VALID)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('auth_required')
  })

  it('400s each malformed field by name', async () => {
    expect((await post({ ...VALID, merchantId: 0 })).status).toBe(400)
    expect((await post({ ...VALID, slug: 'x' })).status).toBe(400)
    expect((await post({ ...VALID, amountUsd8: 'five' })).status).toBe(400)
    expect((await post({ ...VALID, amountUsd8: -1 })).status).toBe(400)
    const bad = await post({ ...VALID, note: 'x'.repeat(500) })
    expect(bad.status).toBe(400)
  })

  it('201s with the full intent for the creating merchant', async () => {
    const res = await post({ ...VALID, note: 'table 4' })
    expect(res.status).toBe(201)
    const { intent } = (await res.json()) as { intent: Record<string, unknown> }
    expect(intent.intentId).toMatch(/^[0-9A-Z]{26}$/)
    expect(intent.tenantId).toBe('0x' + 'ab'.repeat(20))
    expect(intent.status).toBe('created')
    expect(intent.note).toBe('table 4')
  })
})

describe('GET /api/intents/[id]', () => {
  it('404s an unknown id', async () => {
    expect((await getById('0'.repeat(26))).status).toBe(404)
  })

  it('serves the narrow public projection — no tenant, register, or note', async () => {
    const intent = createIntent({ ...VALID, registerId: 'reg-9', note: 'secret' })
    const res = await getById(intent.intentId)
    expect(res.status).toBe(200)
    const raw = JSON.stringify(await res.json())
    expect(raw).toContain(intent.intentId)
    expect(raw).not.toContain('ab'.repeat(20))
    expect(raw).not.toContain('reg-9')
    expect(raw).not.toContain('secret')
  })

  it('reflects lazy expiry to the customer', async () => {
    const intent = createIntent({ ...VALID, ttlMs: 1 }, 1)
    // Real wall-clock is far past createdAt=1ms, so the store flips on read.
    const res = await getById(intent.intentId)
    const { intent: pub } = (await res.json()) as { intent: { status: string } }
    expect(pub.status).toBe('expired')
  })
})
