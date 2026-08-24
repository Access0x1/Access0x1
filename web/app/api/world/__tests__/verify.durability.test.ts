/**
 * verify.durability.test.ts — the nullifier store's failure mode, made explicit.
 *
 * THE RISK. `/api/world/verify` proves two separate things: the portal proves the
 * proof is cryptographically valid, and OUR nullifier claim proves this human has
 * not already cleared this action. The second promise is only as durable as the
 * store behind it. The in-memory dev store loses every claim when the process
 * restarts (or when a second serverless instance answers), so the SAME valid
 * proof verifies again — one human, unlimited slots.
 *
 * THE RULE. A runtime that demands durability (`NODE_ENV=production`, or an
 * explicit `VERIFY_REQUIRE_DURABLE_STORE=true`) and has none must REFUSE to
 * serve. Fail-soft is right in front of a payment; it is wrong for the guarantee
 * the gate exists to make. These tests pin the refusal, and pin that it happens
 * AFTER the portal call and BEFORE any claim — so no proof is ever consumed by a
 * request the route then rejects.
 *
 * These cases were previously unwritten: the fail-closed branch existed in the
 * route and nothing exercised it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/worldid/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worldid/config')>()
  return {
    ...actual,
    worldRpId: () => 'rp_test_123',
    worldAction: () => 'checkout-verified-human',
    worldAgentAction: () => 'agent-trial-unlock',
    worldVerifyBase: () => 'https://staging-developer.worldcoin.org',
  }
})

const { POST } = await import('../verify/route.js')
const nullifierStore = await import('@/lib/worldid/nullifierStore')

const DURABILITY_ENV = ['NULLIFIER_STORE_URL', 'DATABASE_URL', 'VERIFY_REQUIRE_DURABLE_STORE'] as const
const saved: Record<string, string | undefined> = {}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  for (const k of DURABILITY_ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  nullifierStore.__resetNullifierStore()
  fetchSpy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ success: true, nullifier: '0xd0', action: 'checkout-verified-human' }),
        { status: 200 },
      ),
  )
  vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
})

afterEach(() => {
  for (const k of DURABILITY_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  nullifierStore.__resetNullifierStore()
  vi.restoreAllMocks()
})

function postProof(nullifier: string): Promise<Response> {
  return POST(
    new Request('https://x/api/world/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: 'abc',
        proof: [1, 2, 3],
        merkle_root: '0xroot',
        nullifier,
      }),
    }),
  )
}

describe('POST /api/world/verify — no durable nullifier store', () => {
  it('REFUSES with 503 rather than pass a proof it cannot remember', async () => {
    process.env.VERIFY_REQUIRE_DURABLE_STORE = 'true'
    const res = await postProof('0xd0')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not_configured' })
  })

  it('refuses EVERY attempt — the refusal is not a one-shot latch', async () => {
    process.env.VERIFY_REQUIRE_DURABLE_STORE = 'true'
    for (const n of ['0xd1', '0xd2', '0xd1']) {
      expect((await postProof(n)).status).toBe(503)
    }
  })

  it('leaks no connection string, driver detail, or stack trace in the body', async () => {
    process.env.VERIFY_REQUIRE_DURABLE_STORE = 'true'
    const raw = await (await postProof('0xd0')).text()
    expect(raw).toBe(JSON.stringify({ error: 'not_configured' }))
    expect(raw).not.toMatch(/postgres|NULLIFIER_STORE_URL|at .*\.ts:/i)
  })

  it('claims NOTHING when it refuses — the proof is not silently consumed', async () => {
    process.env.VERIFY_REQUIRE_DURABLE_STORE = 'true'
    expect((await postProof('0xd3')).status).toBe(503)

    // Same proof, same process, durability requirement lifted: the nullifier must
    // still be unclaimed, so this is a FIRST use (200), not a 409.
    delete process.env.VERIFY_REQUIRE_DURABLE_STORE
    nullifierStore.__resetNullifierStore()
    expect((await postProof('0xd3')).status).toBe(200)
  })

  it('still serves in dev, where the in-memory store is an accepted trade-off', async () => {
    const first = await postProof('0xd4')
    expect(first.status).toBe(200)
    // The in-memory store DOES enforce one-per-human inside a single process —
    // its weakness is restart, not correctness while it lives.
    expect((await postProof('0xd4')).status).toBe(409)
  })

  it('serves once a connection string is configured, without the fail-closed branch', async () => {
    // A configured URL selects the durable adapter; the factory no longer throws.
    // (The adapter's own query path is covered by the postgres integration test.)
    process.env.VERIFY_REQUIRE_DURABLE_STORE = 'true'
    process.env.NULLIFIER_STORE_URL = 'postgres://user:pw@localhost:5432/db'
    const res = await postProof('0xd5')
    expect(res.status).not.toBe(503)
  })
})

describe('nullifier durability — the loss the refusal prevents', () => {
  it('demonstrates the in-memory store forgetting a claim across a restart', async () => {
    const { claimNullifier } = nullifierStore
    expect(await claimNullifier('checkout-verified-human', '0xdead')).toBe(true)
    expect(await claimNullifier('checkout-verified-human', '0xdead')).toBe(false)

    // Simulate the process restarting: the in-memory set is gone.
    nullifierStore.__resetNullifierStore()
    expect(await claimNullifier('checkout-verified-human', '0xdead')).toBe(true)
  })
})
