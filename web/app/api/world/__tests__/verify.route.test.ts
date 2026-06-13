/**
 * verify.route.test.ts — POST /api/world/verify (World ID ADR D2 / unit 1).
 *
 * Pins the off-chain Developer-Portal path with the real fetch STUBBED (no
 * network, no booth credentials needed):
 *   - happy path: a valid proof → 200 { ok: true } (the checkout unlocks pay),
 *   - one-human-per-action: the SAME nullifier reused → 409 already_verified,
 *   - a DIFFERENT nullifier → 200 (a different human can still pay),
 *   - a portal rejection (non-200) → 401 proof_invalid,
 *   - a network/transport failure → 502 verify_unreachable,
 *   - the agent action unlocks the Track-A agent trial.
 *
 * The proof payload is forwarded AS-IS; we assert the route hits the v4
 * `/verify/{rp_id}` endpoint (IDKit Incognito Actions, not the retired OIDC).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Pin the env seam so the route is "configured" without real Developer-Portal values.
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
const agentGate = await import('@/lib/worldid/agentGate')

function postProof(body: unknown): Promise<Response> {
  return POST(
    new Request('https://x/api/world/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

/** A minimal raw IDKit-style payload (what the widget hands the route). */
function proof(nullifier: string, action = 'checkout-verified-human'): Record<string, unknown> {
  return {
    action,
    nonce: 'abc',
    proof: [1, 2, 3],
    merkle_root: '0xroot',
    nullifier,
  }
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  nullifierStore.__resetNullifierStore()
  agentGate.__resetAgentTrialForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** Stub the global fetch to mimic the Developer Portal /verify response. */
function stubPortal(impl: (url: string) => Response): void {
  fetchSpy = vi.fn(async (input: unknown) => impl(String(input)))
  vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
}

describe('POST /api/world/verify — happy path', () => {
  it('forwards to the v4 /verify/{rp_id} endpoint and returns 200 on a valid proof', async () => {
    stubPortal(() =>
      new Response(JSON.stringify({ success: true, nullifier: '0x1a', action: 'checkout-verified-human' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const res = await postProof(proof('0x1a'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // Confirm IDKit Incognito Actions path: the v4 portal verify endpoint.
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0])
    expect(calledUrl).toContain('/api/v4/verify/rp_test_123')
    expect(calledUrl).not.toContain('id.worldcoin.org/authorize') // NOT the retired OIDC
  })
})

describe('POST /api/world/verify — one-human-per-action dedup', () => {
  it('rejects a reused nullifier with 409 (UNIQUE(action, nullifier))', async () => {
    stubPortal(() =>
      new Response(JSON.stringify({ success: true, nullifier: '0xdeadbeef', action: 'checkout-verified-human' }), {
        status: 200,
      }),
    )
    const first = await postProof(proof('0xdeadbeef'))
    expect(first.status).toBe(200)

    const second = await postProof(proof('0xdeadbeef'))
    expect(second.status).toBe(409)
    const body = await second.json()
    expect(body.error).toBe('already_verified')
  })

  it('allows a DIFFERENT human (different nullifier) on the same action', async () => {
    let n = 0
    stubPortal(() => {
      n += 1
      return new Response(
        JSON.stringify({ success: true, nullifier: `0x${n}`, action: 'checkout-verified-human' }),
        { status: 200 },
      )
    })
    const a = await postProof(proof('0x1'))
    const b = await postProof(proof('0x2'))
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  })

  it('treats the hex and decimal form of the same nullifier as one human', async () => {
    // 0xff === 255 — must collide regardless of how the portal echoes it.
    stubPortal((url) => {
      const hexThenDecimal = fetchSpy.mock.calls.length === 1 ? '255' : '0xff'
      void url
      return new Response(
        JSON.stringify({ success: true, nullifier: hexThenDecimal, action: 'checkout-verified-human' }),
        { status: 200 },
      )
    })
    const first = await postProof(proof('0xff'))
    expect(first.status).toBe(200)
    const second = await postProof(proof('255'))
    expect(second.status).toBe(409)
  })
})

describe('POST /api/world/verify — failures', () => {
  it('401 proof_invalid when the portal rejects the proof', async () => {
    stubPortal(() =>
      new Response(JSON.stringify({ code: 'verification_failed' }), { status: 400 }),
    )
    const res = await postProof(proof('0xbad1'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('proof_invalid')
    expect(body.code).toBe('verification_failed')
  })

  it('502 verify_unreachable when the portal is unreachable', async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const res = await postProof(proof('0x99'))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('verify_unreachable')
  })

  it('400 invalid_json on a non-JSON body', async () => {
    const res = await POST(
      new Request('https://x/api/world/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/world/verify — Track A agent trial', () => {
  it('unlocks the agent trial when the proof is for the agent action', async () => {
    stubPortal(() =>
      new Response(JSON.stringify({ success: true, nullifier: '0xa9', action: 'agent-trial-unlock' }), {
        status: 200,
      }),
    )
    expect(agentGate.isAgentTrialUnlocked()).toBe(false)
    const res = await postProof(proof('0xa9', 'agent-trial-unlock'))
    expect(res.status).toBe(200)
    expect(agentGate.isAgentTrialUnlocked()).toBe(true)
  })

  it('does NOT unlock the agent trial for a buyer-gate proof', async () => {
    stubPortal(() =>
      new Response(JSON.stringify({ success: true, nullifier: '0xb1', action: 'checkout-verified-human' }), {
        status: 200,
      }),
    )
    await postProof(proof('0xb1'))
    expect(agentGate.isAgentTrialUnlocked()).toBe(false)
  })
})
