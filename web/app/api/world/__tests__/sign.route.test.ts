/**
 * sign.route.test.ts — GET /api/world/sign (World ID ADR D2 / unit 1).
 *
 * The regression this file exists to prevent: a proof is bound to
 * `hash(app_id, action)`, so the action the RP context is SIGNED for must equal
 * the action the widget generates the proof against. The widget is a client
 * bundle and the action env vars are server-only (no `NEXT_PUBLIC_` prefix), so
 * the widget could not read them — it used the baked default while the server
 * used the configured value, and any deployment that customised an action got a
 * silent 401 `proof_invalid`. The fix is that this route PUBLISHES the action it
 * signed. These tests pin that contract.
 *
 * `@worldcoin/idkit/signing` is stubbed so no real key is needed and nothing
 * touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Capture what the route asked to be signed. */
const signCalls: Array<{ signingKeyHex: string; action: string }> = []

vi.mock('@worldcoin/idkit/signing', () => ({
  signRequest: (params: { signingKeyHex: string; action: string }) => {
    signCalls.push(params)
    return { sig: '0xsig', nonce: 'nonce-1', createdAt: 1000, expiresAt: 1300 }
  },
}))

const ENV_KEYS = [
  'WORLD_RP_ID',
  'WORLD_SIGNING_KEY',
  'WORLD_ACTION',
  'WORLD_OPERATOR_ACTION',
  'WORLD_AGENT_ACTION',
  'WORLD_AGENTKIT_ACTION',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  signCalls.length = 0
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  process.env.WORLD_RP_ID = 'rp_test_123'
  process.env.WORLD_SIGNING_KEY = '0xdeadbeef'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** Call the route with an optional `?gate=` selector. */
async function get(gate?: string): Promise<Response> {
  const { GET } = await import('../sign/route.js')
  const url = gate === undefined
    ? 'https://x/api/world/sign'
    : `https://x/api/world/sign?gate=${encodeURIComponent(gate)}`
  return GET(new Request(url))
}

describe('GET /api/world/sign — the action is published, never guessed', () => {
  it('returns the buyer action alongside the rp_context by default', async () => {
    process.env.WORLD_ACTION = 'custom-buyer-action'
    const res = await get()
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.action).toBe('custom-buyer-action')
    expect(body.gate).toBe('buyer')
    expect(body.rp_id).toBe('rp_test_123')
    expect(body.signature).toBe('0xsig')
    expect(body.nonce).toBe('nonce-1')
    expect(body.created_at).toBe(1000)
    expect(body.expires_at).toBe(1300)
  })

  it('SIGNS the same action it publishes — the mismatch that caused the silent 401', async () => {
    process.env.WORLD_ACTION = 'custom-buyer-action'
    const res = await get()
    const body = (await res.json()) as { action: string }
    expect(signCalls).toHaveLength(1)
    expect(signCalls[0]?.action).toBe(body.action)
  })

  it('resolves each named gate to its OWN configured action', async () => {
    process.env.WORLD_ACTION = 'buyer-a'
    process.env.WORLD_OPERATOR_ACTION = 'operator-a'
    process.env.WORLD_AGENT_ACTION = 'agent-a'
    process.env.WORLD_AGENTKIT_ACTION = 'agentkit-a'

    for (const [gate, action] of [
      ['buyer', 'buyer-a'],
      ['operator', 'operator-a'],
      ['agent', 'agent-a'],
      ['agentkit', 'agentkit-a'],
    ] as const) {
      signCalls.length = 0
      const body = (await (await get(gate)).json()) as { action: string; gate: string }
      expect(body.gate).toBe(gate)
      expect(body.action).toBe(action)
      expect(signCalls[0]?.action).toBe(action)
    }
  })

  it('falls back to the buyer gate for an unrecognised gate — no scope widening', async () => {
    process.env.WORLD_ACTION = 'buyer-a'
    process.env.WORLD_OPERATOR_ACTION = 'operator-a'
    const body = (await (await get('operator; drop')).json()) as { action: string; gate: string }
    expect(body.gate).toBe('buyer')
    expect(body.action).toBe('buyer-a')
  })

  it('never accepts a caller-supplied action string', async () => {
    process.env.WORLD_ACTION = 'buyer-a'
    const { GET } = await import('../sign/route.js')
    const res = await GET(
      new Request('https://x/api/world/sign?action=attacker-chosen&gate=buyer'),
    )
    const body = (await res.json()) as { action: string }
    expect(body.action).toBe('buyer-a')
    expect(signCalls[0]?.action).toBe('buyer-a')
  })
})

describe('GET /api/world/sign — dormant + secrets', () => {
  it('503 not_configured when the rp id is blank, without signing anything', async () => {
    delete process.env.WORLD_RP_ID
    const res = await get()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not_configured' })
    expect(signCalls).toHaveLength(0)
  })

  it('503 not_configured when the signing key is blank', async () => {
    delete process.env.WORLD_SIGNING_KEY
    const res = await get()
    expect(res.status).toBe(503)
    expect(signCalls).toHaveLength(0)
  })

  it('never puts the signing key in the response body (secrets law)', async () => {
    process.env.WORLD_SIGNING_KEY = '0xsupersecretkeymaterial'
    const raw = await (await get()).text()
    expect(raw).not.toContain('supersecret')
    expect(raw).not.toContain('0xsupersecretkeymaterial')
  })

  it('is never cached — each rp_context is single-use', async () => {
    const res = await get()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})
