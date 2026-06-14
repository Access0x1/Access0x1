/**
 * @file facts.test.ts — the judge knowledge base is complete, grounded, and honest.
 *
 * These pin the contract the /api/ask system prompt depends on:
 *  - every section has a unique id, a title, and a non-trivial body,
 *  - the topics a judge would ask about are all present (zero custody, the
 *    net+fee==gross and refund-never-blocked invariants, oracle pricing, the
 *    agent session mandate, the commerce quartet, multi-chain, the sponsors,
 *    on/off-chain, what was built this weekend, the proof, the business model),
 *  - the brief and system prompt embed those facts and carry the grounding rules,
 *  - it stays HONEST: testnet only, no mainnet, internal (not third-party) audit.
 */
import { describe, expect, it } from 'vitest'

import {
  FACT_SECTIONS,
  JUDGE_BOT_TAGLINE,
  buildFactsBrief,
  buildSystemPrompt,
} from '../facts'

describe('FACT_SECTIONS shape', () => {
  it('every section has a non-empty id, title, and substantial body', () => {
    expect(FACT_SECTIONS.length).toBeGreaterThanOrEqual(12)
    for (const s of FACT_SECTIONS) {
      expect(s.id, 'id').toBeTruthy()
      expect(s.title.length, `title for ${s.id}`).toBeGreaterThan(3)
      // A real grounded paragraph, not a stub.
      expect(s.body.length, `body for ${s.id}`).toBeGreaterThan(120)
    }
  })

  it('section ids are unique', () => {
    const ids = FACT_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('coverage of the judge topics', () => {
  const required = [
    'what-is-it',
    'zero-custody',
    'refund-never-blocked',
    'usd-pricing-oracle',
    'agent-sessions',
    'commerce-quartet',
    'contracts',
    'multi-chain',
    'sponsors',
    'on-chain-vs-off-chain',
    'built-this-weekend',
    'proof',
    'business-model',
    'scope-honesty',
  ]

  it('includes every required topic id', () => {
    const ids = new Set(FACT_SECTIONS.map((s) => s.id))
    for (const id of required) expect(ids.has(id), `missing topic: ${id}`).toBe(true)
  })

  it('names the owned ERCs and the key invariant phrases', () => {
    const brief = buildFactsBrief().toLowerCase()
    expect(brief).toContain('erc-6909')
    expect(brief).toContain('erc-7702')
    expect(brief).toContain('erc-6492')
    expect(brief).toContain('net + platformfee + merchantfee == gross')
    expect(brief).toContain('refund')
    expect(brief).toContain('chainlink')
    expect(brief).toContain('x402')
    // The named sponsors.
    for (const sponsor of ['circle', 'arc', 'dynamic', 'world id', 'unlink', 'ens', 'oidc', 'walrus']) {
      expect(brief, `sponsor ${sponsor}`).toContain(sponsor)
    }
  })
})

describe('proof section accuracy', () => {
  const proofSection = FACT_SECTIONS.find((s) => s.id === 'proof')

  it('exists and contains the current forge test count', () => {
    expect(proofSection).toBeDefined()
    // Forge contract tests — update this when the suite grows.
    expect(proofSection!.body).toContain('846 contract tests')
    expect(proofSection!.body).toContain('84 suites')
  })

  it('contains the current web vitest test count', () => {
    expect(proofSection!.body).toContain('709 tests')
  })

  it('states the combined total', () => {
    expect(proofSection!.body).toContain('1,555 tests')
  })
})

describe('honesty / no false claims', () => {
  const brief = buildFactsBrief().toLowerCase()

  it('is testnet only and makes no mainnet claim', () => {
    expect(brief).toContain('testnet')
    expect(brief).toContain('no mainnet')
  })

  it('describes the audit as internal, not a third-party audit', () => {
    expect(brief).toContain('internal engineering audit')
    expect(brief).toContain('not a third-party audit')
  })
})

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt()

  it('embeds the full facts brief verbatim', () => {
    expect(prompt).toContain(buildFactsBrief())
  })

  it('carries the grounding rules: answer only from facts, never invent', () => {
    const lower = prompt.toLowerCase()
    expect(lower).toContain('only from the facts')
    expect(lower).toContain('do not know')
    expect(lower).toContain('never invent')
    expect(lower).toContain('booth')
  })
})

describe('tagline', () => {
  it('is a short, grounded one-liner', () => {
    expect(JUDGE_BOT_TAGLINE.length).toBeGreaterThan(20)
    expect(JUDGE_BOT_TAGLINE.toLowerCase()).toContain('access0x1')
  })
})
