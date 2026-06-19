/**
 * @file ensIdentity.test.ts — binding an Access0x1 agent identity to an ENS name.
 *
 * Pins (the load-bearing ones): the ERC-7930 registry encoding is byte-for-byte the ENSIP-25
 * mainnet example (ERC-8004 → `0x000100000101148004…a432`); the ENSIP-25 verification key is
 * exactly `agent-registration[<registry>][<agentId>]`; the reserved `[` `]` characters throw
 * rather than producing a malformed key; ENSIP-26 keys are correct; and the verify/binding
 * reads are READ-ONLY (a missing record is a clean `false`, never a throw; a resolution
 * failure degrades to `addressMatches:false`, never a crash).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildAgentIdentity } from '../identity.js'

// Mock the ENS resolver layer (web/lib/ens) — these are the only network calls; everything
// else is pure. mainnetClient(...).getEnsText is the single text-record read; resolveENS is
// the coinType-safe address resolution.
vi.mock('../../ens', () => ({
  mainnetClient: vi.fn(),
  resolveENS: vi.fn(),
}))

import { mainnetClient, resolveENS } from '../../ens'
import {
  AGENT_CONTEXT_KEY,
  ERC8004_MAINNET_REGISTRY,
  agentEndpointKey,
  agentRegistrationKey,
  erc7930EvmAddress,
  expectedAgentRegistration,
  readAgentRecord,
  verifyAgentBinding,
  verifyAgentRegistration,
} from '../ensIdentity.js'

const OWNER = '0x1111111111111111111111111111111111111111'
const DELEGATE = '0x2222222222222222222222222222222222222222'

function mockGetEnsText(value: string | null) {
  ;(mainnetClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    getEnsText: vi.fn().mockResolvedValue(value),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('erc7930EvmAddress — ENSIP-25 ERC-7930 encoding', () => {
  it('matches the ENSIP-25 mainnet example byte-for-byte (ERC-8004 on chain 1)', () => {
    expect(erc7930EvmAddress(1, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')).toBe(
      '0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432',
    )
  })

  it('encodes a multi-byte chain id with the correct length prefix (Base = 8453)', () => {
    // 8453 = 0x2105 (2 bytes) → chainRefLen = 0x02
    const enc = erc7930EvmAddress(8453, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')
    expect(enc).toBe('0x00010000022105148004a169fb4a3325136eb29fa0ceb6d2e539a432')
  })

  it('throws on a malformed registry address (never invents one)', () => {
    expect(() => erc7930EvmAddress(1, 'not-an-address')).toThrow()
  })
})

describe('agentRegistrationKey — ENSIP-25 verification key', () => {
  it('builds the exact key from the ENSIP-25 example (agent 167)', () => {
    expect(agentRegistrationKey(ERC8004_MAINNET_REGISTRY, '167')).toBe(
      'agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][167]',
    )
  })

  it('accepts a keccak agentId hash as the <agentId> segment', () => {
    const id = buildAgentIdentity({ owner: OWNER, delegate: DELEGATE }).agentId
    expect(agentRegistrationKey(ERC8004_MAINNET_REGISTRY, id)).toContain(`][${id}]`)
  })

  it('throws when the agentId carries the reserved bracket characters', () => {
    expect(() => agentRegistrationKey(ERC8004_MAINNET_REGISTRY, 'a[b]')).toThrow(/\[' or '\]'/)
  })
})

describe('ENSIP-26 keys', () => {
  it('exposes the agent-context entry-point key', () => {
    expect(AGENT_CONTEXT_KEY).toBe('agent-context')
  })

  it('builds agent-endpoint[<protocol>]', () => {
    expect(agentEndpointKey('a2a')).toBe('agent-endpoint[a2a]')
  })

  it('throws on a protocol with reserved brackets', () => {
    expect(() => agentEndpointKey('x[y]')).toThrow()
  })
})

describe('expectedAgentRegistration — the record the owner sets', () => {
  it('uses the agent agentId as the ENSIP-25 id and value "1"', () => {
    const identity = buildAgentIdentity({ owner: OWNER, delegate: DELEGATE })
    const { key, value } = expectedAgentRegistration(identity, ERC8004_MAINNET_REGISTRY)
    expect(value).toBe('1')
    expect(key).toBe(agentRegistrationKey(ERC8004_MAINNET_REGISTRY, identity.agentId))
  })
})

describe('verifyAgentRegistration — ENSIP-25 Registry-to-ENS read', () => {
  it('returns true when the record carries a non-empty value', async () => {
    mockGetEnsText('1')
    await expect(
      verifyAgentRegistration({ name: 'agent.access0x1.eth', registry: ERC8004_MAINNET_REGISTRY, agentId: '167' }),
    ).resolves.toBe(true)
  })

  it('returns false when the record is unset (null) — verification MUST fail', async () => {
    mockGetEnsText(null)
    await expect(
      verifyAgentRegistration({ name: 'agent.access0x1.eth', registry: ERC8004_MAINNET_REGISTRY, agentId: '167' }),
    ).resolves.toBe(false)
  })

  it('returns false on an empty-string value', async () => {
    mockGetEnsText('')
    await expect(
      verifyAgentRegistration({ name: 'agent.access0x1.eth', registry: ERC8004_MAINNET_REGISTRY, agentId: '167' }),
    ).resolves.toBe(false)
  })
})

describe('readAgentRecord — ENSIP-26 record read', () => {
  it('returns the raw value when set', async () => {
    mockGetEnsText('https://agent.example/context.json')
    await expect(
      readAgentRecord({ name: 'agent.access0x1.eth', key: AGENT_CONTEXT_KEY }),
    ).resolves.toBe('https://agent.example/context.json')
  })

  it('returns null when unset', async () => {
    mockGetEnsText(null)
    await expect(readAgentRecord({ name: 'agent.access0x1.eth', key: AGENT_CONTEXT_KEY })).resolves.toBeNull()
  })
})

describe('verifyAgentBinding — the bidirectional check', () => {
  const identity = buildAgentIdentity({ owner: OWNER, delegate: DELEGATE })

  it('bound=true when the name resolves to the delegate AND attests the registration', async () => {
    ;(resolveENS as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(DELEGATE)
    mockGetEnsText('1')
    const r = await verifyAgentBinding({
      name: 'agent.access0x1.eth', identity, registry: ERC8004_MAINNET_REGISTRY, settlementChainId: 8453,
    })
    expect(r).toEqual({ addressMatches: true, registrationAttested: true, bound: true })
  })

  it('bound=false when the name resolves to a DIFFERENT address', async () => {
    ;(resolveENS as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      '0x3333333333333333333333333333333333333333',
    )
    mockGetEnsText('1')
    const r = await verifyAgentBinding({
      name: 'agent.access0x1.eth', identity, registry: ERC8004_MAINNET_REGISTRY, settlementChainId: 8453,
    })
    expect(r.addressMatches).toBe(false)
    expect(r.bound).toBe(false)
  })

  it('does not throw when resolution fails — addressMatches degrades to false', async () => {
    ;(resolveENS as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unresolvable'))
    mockGetEnsText('1')
    const r = await verifyAgentBinding({
      name: 'nope.eth', identity, registry: ERC8004_MAINNET_REGISTRY, settlementChainId: 8453,
    })
    expect(r).toEqual({ addressMatches: false, registrationAttested: true, bound: false })
  })
})
