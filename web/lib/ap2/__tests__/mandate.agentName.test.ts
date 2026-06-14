/**
 * @file mandate.agentName.test.ts — the agent's human NAME on the Intent Mandate card.
 *
 * Pins the additive name surface: when `opts.agentName` is supplied, the Intent
 * Mandate's credentialSubject carries a readable `agentName` AND its `agentNameHash`
 * commitment (the same keccak256(toHex(name)) the merchant uses), so an AP2/A2A
 * counterparty can show a named agent and verify the name against its hash. When no
 * name is supplied, NEITHER field appears (never fabricated). Crucially, the unsigned
 * proof stub is unchanged in TYPE and still covers exactly the credential body — the
 * name addition does not dress the stub up as a real signature (law #4).
 */
import { describe, expect, it } from 'vitest'
import { keccak256, toHex } from 'viem'

import {
  type SessionGrantAuthorization,
  UNSIGNED_PROOF_TYPE,
  contentDigest,
  sessionGrantToIntentMandate,
} from '../mandate.js'

const GRANT: SessionGrantAuthorization = {
  sessionId: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
  owner: '0x1111111111111111111111111111111111111111',
  delegate: '0x2222222222222222222222222222222222222222',
  budgetCap: '100000000',
  spent: '10000000',
  expiry: 4_000_000_000,
  nonce: 0,
  token: '0x3600000000000000000000000000000000000000',
  chainId: 5042002,
}
const OPTS = { nowSeconds: 1_700_000_000 } as const

describe('sessionGrantToIntentMandate — agent name on the card', () => {
  it('carries agentName + its commitment hash when a name is supplied', () => {
    const m = sessionGrantToIntentMandate(GRANT, { ...OPTS, agentName: 'Concierge' })
    expect(m.credentialSubject.agentName).toBe('Concierge')
    expect(m.credentialSubject.agentNameHash).toBe(keccak256(toHex('Concierge')))
  })

  it('trims the supplied name before committing', () => {
    const m = sessionGrantToIntentMandate(GRANT, { ...OPTS, agentName: '  Concierge  ' })
    expect(m.credentialSubject.agentName).toBe('Concierge')
    expect(m.credentialSubject.agentNameHash).toBe(keccak256(toHex('Concierge')))
  })

  it('omits BOTH name fields when no name is supplied (never fabricated)', () => {
    const m = sessionGrantToIntentMandate(GRANT, OPTS)
    expect(m.credentialSubject.agentName).toBeUndefined()
    expect(m.credentialSubject.agentNameHash).toBeUndefined()
  })

  it('omits both fields for a blank/whitespace name', () => {
    const m = sessionGrantToIntentMandate(GRANT, { ...OPTS, agentName: '   ' })
    expect(m.credentialSubject.agentName).toBeUndefined()
    expect(m.credentialSubject.agentNameHash).toBeUndefined()
  })

  it('does NOT change the proof stub honesty — type stays the unsigned stub and covers the body', () => {
    const m = sessionGrantToIntentMandate(GRANT, { ...OPTS, agentName: 'Concierge' })
    // Still the self-describing unsigned stub — never re-typed as a real signature.
    expect(m.proof.type).toBe(UNSIGNED_PROOF_TYPE)
    // The proof's contentDigest still covers exactly the credential body (incl. the
    // new name fields) — so a verifier confirms the eventual signature is over THIS
    // content, name included.
    const { proof: _proof, ...body } = m
    expect(m.proof.contentDigest).toBe(contentDigest(body))
  })
})
