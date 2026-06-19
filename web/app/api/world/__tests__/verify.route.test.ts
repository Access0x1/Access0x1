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

/** The same payload with NO `action` field — the action is derived server-side. */
function proofNoAction(nullifier: string): Record<string, unknown> {
  const { action: _omit, ...rest } = proof(nullifier)
  void _omit
  return rest
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

describe('POST /api/world/verify — C-2: action comes ONLY from server config', () => {
  it('ignores a body `action` and forwards the SERVER buyer action to the portal', async () => {
    // The portal echoes whatever action it received; the route must have sent the
    // server buyer action, NOT the attacker-supplied body action.
    stubPortal((url) => {
      void url
      const sentBody = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body ?? '{}'))
      return new Response(
        JSON.stringify({ success: true, nullifier: '0xc2', action: sentBody.action }),
        { status: 200 },
      )
    })
    // Attacker presents a proof but injects a DIFFERENT action in the body.
    const res = await postProof({ ...proof('0xc2', 'checkout-verified-human'), action: 'attacker-action' })
    expect(res.status).toBe(200)
    const body = await res.json()
    // The verified + claimed action is the trusted server action, never the body's.
    expect(body.action).toBe('checkout-verified-human')
    // The payload forwarded to the portal carried the server action (not the body's).
    const forwarded = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'))
    expect(forwarded.action).toBe('checkout-verified-human')
    expect(forwarded.action).not.toBe('attacker-action')
  })

  it('claims the nullifier under the SERVER action even when the body action differs', async () => {
    // A proof claimed under the buyer action; a second request injecting a
    // different body action but the SAME human must still collide (one human, one
    // slot) — proving the body action does not open a fresh nullifier space.
    stubPortal(() => {
      const sentBody = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body ?? '{}'))
      return new Response(
        JSON.stringify({ success: true, nullifier: '0x5a3e', action: sentBody.action }),
        { status: 200 },
      )
    })
    const first = await postProof(proof('0x5a3e'))
    expect(first.status).toBe(200)
    // Same human, but now lying about the action in the body — must still be 409.
    const second = await postProof({ ...proof('0x5a3e'), action: 'some-other-action' })
    expect(second.status).toBe(409)
    expect((await second.json()).error).toBe('already_verified')
  })

  it('selects the agent gate via the `gate` enum (server action), not a body action', async () => {
    stubPortal(() => {
      const sentBody = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body ?? '{}'))
      return new Response(
        JSON.stringify({ success: true, nullifier: '0xa17e', action: sentBody.action }),
        { status: 200 },
      )
    })
    expect(agentGate.isAgentTrialUnlocked()).toBe(false)
    // No `action` in the body at all — only the trusted `gate` selector.
    const res = await postProof({ ...proofNoAction('0xa17e'), gate: 'agent' })
    expect(res.status).toBe(200)
    const forwarded = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'))
    expect(forwarded.action).toBe('agent-trial-unlock')
    expect(agentGate.isAgentTrialUnlocked()).toBe(true)
  })

  it('a body action of the agent string does NOT reach the agent gate (no gate enum)', async () => {
    // Defeats the old bug shape: presenting `action: 'agent-trial-unlock'` in the
    // body must NOT unlock the agent trial — only the trusted `gate` enum does.
    stubPortal(() => {
      const sentBody = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body ?? '{}'))
      return new Response(
        JSON.stringify({ success: true, nullifier: '0xb2f0', action: sentBody.action }),
        { status: 200 },
      )
    })
    const res = await postProof({ ...proof('0xb2f0'), action: 'agent-trial-unlock' })
    expect(res.status).toBe(200)
    const forwarded = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'))
    expect(forwarded.action).toBe('checkout-verified-human')
    expect(agentGate.isAgentTrialUnlocked()).toBe(false)
  })
})

describe('POST /api/world/verify — Track A agent trial', () => {
  it('unlocks the agent trial when the agent gate is selected (via the trusted enum)', async () => {
    // C-2: the agent gate is now reached by the trusted `gate: 'agent'` selector
    // (the server derives `worldAgentAction()`), NOT by a body `action` string.
    stubPortal(() =>
      new Response(JSON.stringify({ success: true, nullifier: '0xa9', action: 'agent-trial-unlock' }), {
        status: 200,
      }),
    )
    expect(agentGate.isAgentTrialUnlocked()).toBe(false)
    const res = await postProof({ ...proofNoAction('0xa9'), gate: 'agent' })
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
