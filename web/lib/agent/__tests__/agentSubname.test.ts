/**
 * @file agentSubname.test.ts — the agent → ENS subname WRITE binding.
 *
 * Pins the four load-bearing behaviors:
 *  - LABEL: deterministic `agent-<first 16 hex of agentId>`, valid ENS charset, ≤ 63 chars.
 *  - RECORDS (pure): ENSIP-25 attestation key built byte-exact against the spec's ERC-8004
 *    mainnet example, provenance keys carry the FULL agentId/owner/nameHash, ENSIP-26
 *    context/endpoint records appear only when supplied, and reserved brackets THROW.
 *  - FAIL-SOFT: unconfigured ⇒ `not_configured` NO-OP with zero network calls; a
 *    reserved-bracket protocol surfaces as `bad_input` (never a throw, never a mangled key).
 *  - WIRE: the POSTed Namestone body binds the label to the DELEGATE address (leg 1 of
 *    verifyAgentBinding) with the attestation record attached (leg 2).
 *
 * `fetch` is mocked — fully offline. Parent is the generic `yourbrand.eth`, never a literal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_SUBNAME_TEXT_KEYS,
  agentSubnameLabel,
  agentSubnameTexts,
  issueAgentSubname,
} from '../agentSubname'
import { buildAgentIdentity } from '../identity'
import { ERC8004_MAINNET_REGISTRY } from '../ensIdentity'

const OWNER = '0x' + 'a'.repeat(40)
const DELEGATE = '0x' + 'b'.repeat(40)
const PARENT = 'yourbrand.eth'

/** The ENSIP-25 §"Ethereum Example" ERC-7930 encoding of the ERC-8004 mainnet registry. */
const SPEC_REGISTRY_7930 = '0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432'

const identity = buildAgentIdentity({ owner: OWNER, delegate: DELEGATE, displayName: 'Fare Bot' })

const fetchMock = vi.fn()

function configure(): void {
  process.env.NAMESTONE_API_KEY = 'test-key'
  process.env.ENS_SUBNAME_PARENT = PARENT
}
function unconfigure(): void {
  delete process.env.NAMESTONE_API_KEY
  delete process.env.ENS_SUBNAME_PARENT
}

function okResponse(): Response {
  return { ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  unconfigure()
  delete process.env.NAMESTONE_BASE_URL
})
afterEach(() => {
  vi.unstubAllGlobals()
  unconfigure()
})

describe('agentSubnameLabel', () => {
  it('is deterministic: agent- + first 16 hex chars of the agentId', () => {
    const label = agentSubnameLabel(identity)
    expect(label).toBe(`agent-${identity.agentId.slice(2, 18).toLowerCase()}`)
    // Same (owner, delegate) ⇒ same id ⇒ same label, regardless of input casing.
    const again = buildAgentIdentity({ owner: OWNER.toUpperCase().replace('0X', '0x'), delegate: DELEGATE })
    expect(agentSubnameLabel(again)).toBe(label)
  })

  it('fits the ENS label contract: charset [a-z0-9-], ≤ 63 chars', () => {
    const label = agentSubnameLabel(identity)
    expect(label).toMatch(/^[a-z0-9-]{1,63}$/)
    expect(label.length).toBe('agent-'.length + 16)
  })
})

describe('agentSubnameTexts (pure record builder)', () => {
  it('leads with the byte-exact ENSIP-25 attestation for the spec registry', () => {
    const texts = agentSubnameTexts(identity, ERC8004_MAINNET_REGISTRY)
    expect(texts[0]).toEqual({
      key: `agent-registration[${SPEC_REGISTRY_7930}][${identity.agentId}]`,
      value: '1',
    })
  })

  it('carries the FULL agentId, the granting owner, and the nameHash commitment', () => {
    const texts = agentSubnameTexts(identity, ERC8004_MAINNET_REGISTRY)
    const byKey = Object.fromEntries(texts.map((t) => [t.key, t.value]))
    expect(byKey[AGENT_SUBNAME_TEXT_KEYS.agentId]).toBe(identity.agentId)
    expect(byKey[AGENT_SUBNAME_TEXT_KEYS.agentOwner]).toBe(identity.owner)
    expect(byKey[AGENT_SUBNAME_TEXT_KEYS.agentNameHash]).toBe(identity.nameHash)
  })

  it('omits the nameHash record for an unnamed agent (no empty records)', () => {
    const unnamed = buildAgentIdentity({ owner: OWNER, delegate: DELEGATE })
    const texts = agentSubnameTexts(unnamed, ERC8004_MAINNET_REGISTRY)
    expect(texts.some((t) => t.key === AGENT_SUBNAME_TEXT_KEYS.agentNameHash)).toBe(false)
  })

  it('adds ENSIP-26 context + endpoint records only when supplied non-blank', () => {
    const texts = agentSubnameTexts(identity, ERC8004_MAINNET_REGISTRY, {
      context: ' https://agents.example/card.json ',
      endpoints: { mcp: 'https://agents.example/mcp', a2a: '  ' },
    })
    const byKey = Object.fromEntries(texts.map((t) => [t.key, t.value]))
    expect(byKey['agent-context']).toBe('https://agents.example/card.json')
    expect(byKey['agent-endpoint[mcp]']).toBe('https://agents.example/mcp')
    // Blank endpoint value ⇒ record skipped entirely, never written empty.
    expect('agent-endpoint[a2a]' in byKey).toBe(false)
  })

  it('THROWS on a reserved-bracket protocol key (ENSIP-26 law — never a wrong key)', () => {
    expect(() =>
      agentSubnameTexts(identity, ERC8004_MAINNET_REGISTRY, {
        endpoints: { 'mcp[evil]': 'https://x' },
      }),
    ).toThrow(/\[/)
  })

  it('publishes the inference choice (click.access0x1.inference) only when a provider is set', () => {
    const withZerog = agentSubnameTexts(identity, ERC8004_MAINNET_REGISTRY, { inferenceProvider: 'zerog' })
    const byKey = Object.fromEntries(withZerog.map((t) => [t.key, t.value]))
    expect(byKey[AGENT_SUBNAME_TEXT_KEYS.inference]).toBe('zerog')
    expect(AGENT_SUBNAME_TEXT_KEYS.inference).toBe('click.access0x1.inference')

    // Unset ⇒ no record at all (an absent record cleanly means "the default backend").
    const without = agentSubnameTexts(identity, ERC8004_MAINNET_REGISTRY)
    expect(without.some((t) => t.key === AGENT_SUBNAME_TEXT_KEYS.inference)).toBe(false)
  })
})

describe('issueAgentSubname — fail-soft seam contract', () => {
  it('returns not_configured with ZERO network calls when the seam is off', async () => {
    const res = await issueAgentSubname({ identity, registry: ERC8004_MAINNET_REGISTRY })
    expect(res).toEqual({ ok: false, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a reserved-bracket protocol as bad_input, never a throw', async () => {
    configure()
    const res = await issueAgentSubname({
      identity,
      registry: ERC8004_MAINNET_REGISTRY,
      discovery: { endpoints: { 'mcp[evil]': 'https://x' } },
    })
    expect(res).toEqual({ ok: false, code: 'bad_input' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs the label bound to the DELEGATE address with the attestation attached', async () => {
    configure()
    fetchMock.mockResolvedValueOnce(okResponse())
    const res = await issueAgentSubname({
      identity,
      registry: ERC8004_MAINNET_REGISTRY,
      discovery: { context: 'https://agents.example/card.json' },
    })

    const label = agentSubnameLabel(identity)
    expect(res).toEqual({
      ok: true,
      name: `${label}.${PARENT}`,
      label,
      parent: PARENT,
      // identity.delegate is the CHECKSUMMED form (buildAgentIdentity normalizes).
      owner: identity.delegate,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/set-name')
    const body = JSON.parse(String(init.body))
    expect(body.domain).toBe(PARENT)
    expect(body.name).toBe(label)
    // Leg 1 of verifyAgentBinding: the name resolves to the DELEGATE (checksummed
    // by buildAgentIdentity), never the granting owner.
    expect(body.address).toBe(identity.delegate)
    // Leg 2: the ENSIP-25 attestation record rides along, value "1".
    expect(body.text_records[`agent-registration[${SPEC_REGISTRY_7930}][${identity.agentId}]`]).toBe('1')
    expect(body.text_records[AGENT_SUBNAME_TEXT_KEYS.agentId]).toBe(identity.agentId)
    expect(body.text_records['agent-context']).toBe('https://agents.example/card.json')
  })

  it('passes upstream failure through as namestone_error (never a throw)', async () => {
    configure()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response)
    const res = await issueAgentSubname({ identity, registry: ERC8004_MAINNET_REGISTRY })
    expect(res).toEqual({ ok: false, code: 'namestone_error', detail: 'status_500' })
  })
})
