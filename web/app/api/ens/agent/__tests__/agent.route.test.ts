/**
 * @file agent.route.test.ts — the /api/ens/agent WRITE route (publish an agent's ENS identity +
 * its inference choice).
 *
 * Pins: derives the identity SERVER-SIDE from (owner, delegate); passes the chosen provider through
 * as discovery.inferenceProvider (the "publish click.access0x1.inference" path); maps the fail-soft
 * codes to HTTP statuses; rejects a malformed registry as bad_input. issueAgentSubname is mocked so
 * the suite is offline (no Namestone, no env). The auth gate runs for real (passes in dev for a
 * valid wallet owner, 401 in production without a verified write).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildAgentIdentity } from '@/lib/agent/identity'

const issueAgentSubname = vi.fn()
vi.mock('@/lib/agent/agentSubname', () => ({
  issueAgentSubname: (input: unknown) => issueAgentSubname(input),
}))

const { POST } = await import('../route.js')

const OWNER = '0x' + '1'.repeat(40)
const DELEGATE = '0x' + '2'.repeat(40)
const REGISTRY = { chainId: 1, address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }

function post(body: unknown): Request {
  return new Request('https://x/api/ens/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => issueAgentSubname.mockReset())
afterEach(() => vi.clearAllMocks())

describe('POST /api/ens/agent', () => {
  it('400 on invalid json', async () => {
    const res = await POST(post('{not json'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_json')
  })

  it('400 bad_input when the registry is missing/invalid (never issue against a guess)', async () => {
    const res = await POST(post({ owner: OWNER, delegate: DELEGATE }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('bad_input')
    expect(issueAgentSubname).not.toHaveBeenCalled()
  })

  it('publishes the agent identity + inference choice, deriving agentId server-side', async () => {
    const identity = buildAgentIdentity({ owner: OWNER, delegate: DELEGATE })
    issueAgentSubname.mockResolvedValue({ ok: true, name: `agent-x.yourbrand.eth` })

    const res = await POST(
      post({ owner: OWNER, delegate: DELEGATE, registry: REGISTRY, inferenceProvider: 'zerog' }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      name: 'agent-x.yourbrand.eth',
      agentId: identity.agentId,
      inferenceProvider: 'zerog',
    })
    // The provider flows through as discovery.inferenceProvider (⇒ the click.access0x1.inference
    // record), and the agentId is the server-derived keccak(owner, delegate) — not client-supplied.
    expect(issueAgentSubname).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ agentId: identity.agentId, owner: identity.owner }),
        registry: REGISTRY,
        discovery: expect.objectContaining({ inferenceProvider: 'zerog' }),
      }),
    )
  })

  it('omits the inference record when no provider is chosen (unset ⇒ default backend)', async () => {
    issueAgentSubname.mockResolvedValue({ ok: true, name: 'agent-x.yourbrand.eth' })
    const res = await POST(post({ owner: OWNER, delegate: DELEGATE, registry: REGISTRY }))
    expect(res.status).toBe(200)
    expect((await res.json()).inferenceProvider).toBeNull()
    const arg = issueAgentSubname.mock.calls[0][0] as { discovery: { inferenceProvider?: string } }
    expect(arg.discovery.inferenceProvider).toBeUndefined()
  })

  it('maps the fail-soft not_configured code to 503 (seam off)', async () => {
    issueAgentSubname.mockResolvedValue({ ok: false, code: 'not_configured' })
    const res = await POST(post({ owner: OWNER, delegate: DELEGATE, registry: REGISTRY }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('not_configured')
  })

  it('401 and issues NOTHING for an unverified write when verified writes are required', async () => {
    process.env.BRANDING_REQUIRE_VERIFIED_WRITES = 'true'
    try {
      const res = await POST(post({ owner: OWNER, delegate: DELEGATE, registry: REGISTRY }))
      expect(res.status).toBe(401)
      expect(issueAgentSubname).not.toHaveBeenCalled()
    } finally {
      delete process.env.BRANDING_REQUIRE_VERIFIED_WRITES
    }
  })
})
