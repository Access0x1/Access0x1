/**
 * @file identity.test.ts — the deterministic, named agent identity record.
 *
 * Pins: `agentId = keccak256(abi.encode(owner, delegate))` is deterministic and
 * casing-invariant (the same pair always yields the same id); the human display
 * NAME is never put on the record — only its `nameHash` commitment is (mirroring the
 * merchant nameHash, law #4); and a malformed address THROWS rather than inventing a
 * zero address.
 */
import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, getAddress, keccak256, toHex } from 'viem'

import {
  agentNameHash,
  buildAgentIdentity,
  computeAgentId,
  type AgentIdentity,
} from '../identity.js'

const OWNER = '0x1111111111111111111111111111111111111111'
const DELEGATE = '0x2222222222222222222222222222222222222222'

/** Independently recompute the expected id the way the contract encodes its ids. */
function expectedAgentId(owner: string, delegate: string): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }],
      [getAddress(owner), getAddress(delegate)],
    ),
  )
}

describe('computeAgentId — determinism', () => {
  it('is keccak256(abi.encode(owner, delegate)) — matches an independent recompute', () => {
    expect(computeAgentId(OWNER, DELEGATE)).toBe(expectedAgentId(OWNER, DELEGATE))
  })

  it('is deterministic: the same pair always yields the same id', () => {
    expect(computeAgentId(OWNER, DELEGATE)).toBe(computeAgentId(OWNER, DELEGATE))
  })

  it('is casing-invariant (checksummed internally): upper/lower input agree', () => {
    const lower = computeAgentId(OWNER.toLowerCase(), DELEGATE.toLowerCase())
    const upper = computeAgentId(OWNER.toUpperCase().replace('0X', '0x'), DELEGATE)
    expect(lower).toBe(computeAgentId(OWNER, DELEGATE))
    expect(upper).toBe(computeAgentId(OWNER, DELEGATE))
  })

  it('is order-sensitive: (owner, delegate) != (delegate, owner)', () => {
    expect(computeAgentId(OWNER, DELEGATE)).not.toBe(computeAgentId(DELEGATE, OWNER))
  })

  it('a different delegate yields a different id', () => {
    const other = '0x3333333333333333333333333333333333333333'
    expect(computeAgentId(OWNER, other)).not.toBe(computeAgentId(OWNER, DELEGATE))
  })

  it('produces a 0x-prefixed bytes32 (66-char) hex', () => {
    expect(computeAgentId(OWNER, DELEGATE)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('throws (never invents an address) on a malformed owner/delegate', () => {
    expect(() => computeAgentId('not-an-address', DELEGATE)).toThrow(/owner/)
    expect(() => computeAgentId(OWNER, '0x1234')).toThrow(/delegate/)
    expect(() => computeAgentId('', DELEGATE)).toThrow(/owner/)
  })
})

describe('agentNameHash — name commit (plaintext never leaves the client)', () => {
  it('is keccak256(toHex(name)) — the same shape as the merchant nameHash', () => {
    expect(agentNameHash('Concierge')).toBe(keccak256(toHex('Concierge')))
  })

  it('trims before hashing so surrounding whitespace does not change the commit', () => {
    expect(agentNameHash('  Concierge  ')).toBe(agentNameHash('Concierge'))
  })

  it('returns null for an empty / blank name (nothing to commit)', () => {
    expect(agentNameHash('')).toBeNull()
    expect(agentNameHash('   ')).toBeNull()
    expect(agentNameHash(null)).toBeNull()
    expect(agentNameHash(undefined)).toBeNull()
  })

  it('different names hash to different commitments', () => {
    expect(agentNameHash('Alice')).not.toBe(agentNameHash('Bob'))
  })
})

describe('buildAgentIdentity — the safe-to-publish record', () => {
  it('carries the derived id, checksummed addresses, and ONLY the name commitment', () => {
    const rec: AgentIdentity = buildAgentIdentity({
      owner: OWNER,
      delegate: DELEGATE,
      displayName: 'Concierge',
    })
    expect(rec.agentId).toBe(computeAgentId(OWNER, DELEGATE))
    expect(rec.owner).toBe(getAddress(OWNER))
    expect(rec.delegate).toBe(getAddress(DELEGATE))
    expect(rec.nameHash).toBe(keccak256(toHex('Concierge')))
    // The plaintext name is NEVER on the published record (only the hash).
    expect(JSON.stringify(rec)).not.toContain('Concierge')
  })

  it('nameHash is null when no display name is supplied', () => {
    const rec = buildAgentIdentity({ owner: OWNER, delegate: DELEGATE })
    expect(rec.nameHash).toBeNull()
    expect(rec.agentId).toBe(computeAgentId(OWNER, DELEGATE))
  })

  it('throws on a malformed address (never fabricates a principal)', () => {
    expect(() => buildAgentIdentity({ owner: 'x', delegate: DELEGATE })).toThrow(/owner/)
  })
})
