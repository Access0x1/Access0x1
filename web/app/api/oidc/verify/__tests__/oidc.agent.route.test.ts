/**
 * @file oidc.agent.route.test.ts — binding Google-verify to the AGENT.
 *
 * Pins the "verify for all → agent" leg: when the verified OIDC token carries a
 * valid `agentId` in its agent claim, the route records `oidc` against the AGENT
 * profile (so "this agent is Google-verified" is durably queryable) AND echoes the
 * derived agent block. It stays fail-soft: an UNCONFIGURED verify records nothing on
 * the agent, and a present-but-malformed agent claim binds no agent (no throw). The
 * verify lib + subject store are mocked so the suite is offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyOidcToken = vi.fn()
vi.mock('@/lib/oidc/verify', () => ({
  verifyOidcToken: (token: unknown) => verifyOidcToken(token),
}))
vi.mock('@/lib/oidc/config', () => ({ oidcIssuer: () => 'https://accounts.google.com' }))

const { POST } = await import('../route.js')
const store = await import('@/lib/verification/store')
const subjects = await import('@/lib/oidc/subjectStore')
const { computeAgentId } = await import('@/lib/agent/identity')

const USER = '0x' + '1'.repeat(40)
const AGENT = computeAgentId(
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
)

function post(body: unknown): Request {
  return new Request('https://x/api/oidc/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  store.__resetVerificationStore()
  subjects.__resetSubjectStore()
  verifyOidcToken.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/oidc/verify — verified agent token binds the AGENT', () => {
  it('records `oidc` against the agentId and the agent profile climbs to Verified', async () => {
    verifyOidcToken.mockResolvedValue({
      ok: true,
      identity: { subject: 'sub-agent-1', email: 'a@b.c', agent: AGENT },
    })
    const res = await POST(post({ user: USER, token: 'good.jwt' }))
    const json = await res.json()
    expect(res.status).toBe(200)

    // The user is recorded as before.
    expect(json.methods).toEqual(['oidc'])
    // The AGENT block is echoed and the AGENT profile is durably queryable.
    expect(json.agentProfile.agentId).toBe(AGENT.toLowerCase())
    expect(json.agentProfile.methods).toEqual(['oidc'])
    expect(json.agentProfile.tier).toBe('verified')
    expect(store.getAgentProfile(AGENT).methods).toEqual(['oidc'])
    // The user wallet did NOT inherit the agent's record (separate key spaces).
    expect(store.getProfile(USER).methods).toEqual(['oidc'])
  })

  it('no agent claim ⇒ no agent profile bound (agentProfile is null)', async () => {
    verifyOidcToken.mockResolvedValue({
      ok: true,
      identity: { subject: 'sub-no-agent', email: null, agent: null },
    })
    const json = await (await POST(post({ user: USER, token: 'good.jwt' }))).json()
    expect(json.agentProfile).toBeNull()
  })

  it('fail-soft: a malformed agent claim binds nothing and never throws (user still verifies)', async () => {
    verifyOidcToken.mockResolvedValue({
      ok: true,
      // A provider opaque id that is NOT a bytes32 agentId.
      identity: { subject: 'sub-bad-agent', email: null, agent: 'agent-007' },
    })
    const res = await POST(post({ user: USER, token: 'good.jwt' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    // The user verification stands; the agent claim is echoed but not bound.
    expect(json.methods).toEqual(['oidc'])
    expect(json.oidc.agent).toBe('agent-007')
    expect(json.agentProfile).toBeNull()
  })

  it('unconfigured (booth-gated) records NOTHING on the agent (no faked pass)', async () => {
    verifyOidcToken.mockResolvedValue({ ok: false, code: 'not_configured' })
    const res = await POST(post({ user: USER, token: 'x' }))
    expect(res.status).toBe(503)
    expect(store.getAgentProfile(AGENT).methods).toEqual([])
    expect(store.getProfile(USER).methods).toEqual([])
  })

  it('token_invalid records NOTHING on the agent (fail-soft, never a forge)', async () => {
    verifyOidcToken.mockResolvedValue({ ok: false, code: 'token_invalid' })
    const res = await POST(post({ user: USER, token: 'forged' }))
    expect(res.status).toBe(401)
    expect(store.getAgentProfile(AGENT).methods).toEqual([])
  })
})
