/**
 * @file retrieve.test.ts — pins the BM25 retriever that replaces the
 * whole-corpus prompt (lib/docs/retrieve.ts).
 *
 * Retrieval trades recall for cost, so the tests that matter are the ones that
 * catch the trade going wrong:
 *  - a real question about a real documented topic surfaces THAT topic's doc
 *    inside the top-k — checked across several unrelated areas of the corpus,
 *    because a ranker can look fine on one query and be useless on the next,
 *  - a question with nothing to match returns NOTHING rather than the eight
 *    least-irrelevant chunks, which is what lets the route fall back honestly,
 *  - blank, punctuation-only, and emoji questions do not throw,
 *  - ranking is deterministic, so a retrieval regression lands as a diff.
 */
import { describe, expect, it } from 'vitest'

import { DOCS_GROUNDING_INSTRUCTION, buildDocsSystemPrompt } from '../corpus.js'
import {
  BM25_B,
  BM25_K1,
  DEFAULT_TOP_K,
  MIN_CHUNK_SCORE,
  RETRIEVAL_SCOPE_NOTE,
  RETRIEVED_PROMPT_BYTE_CEILING,
  buildRetrievedSystemPrompt,
  chunkDocument,
  getDocChunks,
  tokenize,
  topK,
} from '../retrieve.js'

/** The files a question's top-k cited, deduplicated. */
function filesFor(question: string, k?: number): string[] {
  return [...new Set(topK(question, k).map((hit) => hit.chunk.file))]
}

describe('the index', () => {
  it('splits the corpus into hundreds of heading-sized chunks', () => {
    const chunks = getDocChunks()
    // The measured split is 517 chunks over 32 docs; the assertion stays a band
    // so authoring a doc does not break the suite, while a collapse to one
    // chunk per file (a broken split regex) still fails loudly.
    expect(chunks.length).toBeGreaterThan(300)
    expect(chunks.length).toBeGreaterThan(new Set(chunks.map((c) => c.file)).size * 4)
  })

  it('carries a source filename and a heading on every chunk, for citation', () => {
    for (const chunk of getDocChunks()) {
      expect(chunk.file).toMatch(/\.md$/)
      expect(chunk.heading.length).toBeGreaterThan(0)
      expect(chunk.text.trim().length).toBeGreaterThan(0)
    }
  })

  it('uses the standard BM25 parameters', () => {
    expect(BM25_K1).toBe(1.2)
    expect(BM25_B).toBe(0.75)
  })
})

describe('chunkDocument', () => {
  it('splits before every H1/H2/H3 and keeps the pre-heading preamble', () => {
    const chunks = chunkDocument('X.md', 'intro line\n\n# One\nbody one\n\n## Two\nbody two\n\n### Three\nbody three')
    expect(chunks.map((c) => c.heading)).toEqual(['intro line', 'One', 'Two', 'Three'])
    expect(chunks[2].text).toContain('body two')
    expect(chunks.every((c) => c.file === 'X.md')).toBe(true)
  })

  it('leaves an H4 and a hash inside a fenced block attached to their section', () => {
    const chunks = chunkDocument('X.md', '# One\nbody\n#### deep\nmore\n')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('#### deep')
  })

  it('returns nothing for an empty document', () => {
    expect(chunkDocument('X.md', '   \n\n  ')).toEqual([])
  })
})

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, and keeps digits', () => {
    expect(tokenize('Arc Testnet (5042002) — USDC/USD feed')).toEqual([
      'arc',
      'testnet',
      '5042002',
      'usdc',
      'usd',
      'feed',
    ])
  })

  it('returns an empty list for text with no alphanumerics', () => {
    expect(tokenize('  ???  — 🙂 ')).toEqual([])
  })
})

describe('a real question surfaces its own documentation', () => {
  // One case per unrelated area of the corpus: registration, pricing, the fee
  // split, chain coverage, the doc map, and a deep reference page.
  const cases: readonly { question: string; expected: string }[] = [
    { question: 'How do I register a merchant?', expected: 'FAQ.md' },
    { question: 'How is a payment priced in USD?', expected: 'ARCHITECTURE.md' },
    { question: 'How is the platform fee split?', expected: 'PLATFORM-FEE.md' },
    { question: 'Which testnets are supported?', expected: 'QUICKSTART.md' },
    { question: 'Where should I start?', expected: 'START-HERE.md' },
    { question: 'What are the storage layout slots?', expected: 'STORAGE-LAYOUT.md' },
    { question: 'How do I deploy to Arc testnet?', expected: 'ARC-DEPLOY.md' },
    { question: 'zksync era testing gotchas', expected: 'ZKSYNC-TESTING.md' },
    { question: 'What is a SessionGrant budget?', expected: 'ARCHITECTURE.md' },
  ]

  for (const { question, expected } of cases) {
    it(`ranks docs/${expected} into the top-${DEFAULT_TOP_K} for "${question}"`, () => {
      expect(filesFor(question)).toContain(expected)
    })
  }

  it('puts the exact FAQ entry first when the question restates it', () => {
    const [best] = topK('Does the protocol ever hold my money?')
    expect(best.chunk.file).toBe('FAQ.md')
    expect(best.chunk.heading).toContain('hold my money')
  })
})

describe('the shape of a result set', () => {
  it('returns at most k chunks, best first, every one above the floor', () => {
    const hits = topK('How is the platform fee split?')
    expect(hits.length).toBeLessThanOrEqual(DEFAULT_TOP_K)
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) expect(hit.score).toBeGreaterThanOrEqual(MIN_CHUNK_SCORE)
    const scores = hits.map((h) => h.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })

  it('honors an explicit k', () => {
    expect(topK('How is the platform fee split?', 3)).toHaveLength(3)
    expect(topK('How is the platform fee split?', 1)).toHaveLength(1)
  })

  it('falls back to the default k for a nonsensical k', () => {
    expect(topK('How is the platform fee split?', 0).length).toBe(DEFAULT_TOP_K)
    expect(topK('How is the platform fee split?', Number.NaN).length).toBe(DEFAULT_TOP_K)
  })

  it('ranks the same question identically every time', () => {
    const once = topK('How is a payment priced in USD?')
    const twice = topK('How is a payment priced in USD?')
    expect(twice.map((h) => [h.chunk.file, h.chunk.heading, h.score])).toEqual(
      once.map((h) => [h.chunk.file, h.chunk.heading, h.score]),
    )
  })
})

describe('a question the docs cannot answer returns nothing, and never throws', () => {
  const nonsense: readonly string[] = ['', '   ', '???', '🙂🙂', 'asdfghjkl qwertyuiop zxcvbnm', '\n\t']

  for (const question of nonsense) {
    it(`returns [] for ${JSON.stringify(question)}`, () => {
      expect(() => topK(question)).not.toThrow()
      expect(topK(question)).toEqual([])
    })
  }

  it('survives a very long question without throwing', () => {
    expect(() => topK('router fee '.repeat(500))).not.toThrow()
  })
})

describe('buildRetrievedSystemPrompt', () => {
  const questions: readonly string[] = [
    'How do I register a merchant?',
    'How is a payment priced in USD?',
    'Which testnets are supported?',
    'How is the platform fee split?',
    'Where should I start?',
    'What are the storage layout slots for subscriptions, bookings and gift cards?',
  ]

  it('always carries the grounding instruction and the scope note', () => {
    // Including for a question that retrieved nothing: a prompt that lost its
    // rules would be a prompt that invents addresses.
    for (const question of [...questions, 'asdfghjkl qwertyuiop', '']) {
      const built = buildRetrievedSystemPrompt(question)
      expect(built.prompt).toContain(DOCS_GROUNDING_INSTRUCTION)
      expect(built.prompt).toContain(RETRIEVAL_SCOPE_NOTE)
      expect(built.prompt).toContain('=== DOCUMENTATION ===')
      expect(built.prompt).toContain('=== END DOCUMENTATION ===')
    }
  })

  it('stays under the byte ceiling for every question', () => {
    for (const question of questions) {
      const built = buildRetrievedSystemPrompt(question)
      expect(built.bytes).toBeLessThanOrEqual(RETRIEVED_PROMPT_BYTE_CEILING)
      expect(built.bytes).toBe(new TextEncoder().encode(built.prompt).length)
    }
  })

  it('is two orders of magnitude smaller than the whole-corpus prompt', () => {
    // The whole point of the increment, asserted rather than asserted-about:
    // ~497,000 bytes of corpus becomes single-digit thousands per question.
    const corpusBytes = new TextEncoder().encode(buildDocsSystemPrompt()).length
    for (const question of questions) {
      expect(buildRetrievedSystemPrompt(question).bytes * 20).toBeLessThan(corpusBytes)
    }
  })

  it('emits the SAME citation headers whole-corpus mode uses', () => {
    // Citation rule 2 names the "===== docs/<FILE> =====" markers, so the two
    // modes must format them identically or the rule stops resolving.
    const built = buildRetrievedSystemPrompt('How is the platform fee split?')
    for (const hit of built.chunks) {
      expect(built.prompt).toContain(`===== docs/${hit.chunk.file} =====`)
      expect(built.prompt).toContain(hit.chunk.text)
    }
  })

  it('reports matched=false with no passages when nothing clears the floor', () => {
    for (const question of ['', '   ', '???', 'asdfghjkl qwertyuiop zxcvbnm']) {
      const built = buildRetrievedSystemPrompt(question)
      expect(built.matched).toBe(false)
      expect(built.chunks).toHaveLength(0)
      // The instruction quotes the header FORM ("===== docs/<FILE> ====="), so
      // the check looks for a real filename in it — an actual passage header.
      expect(built.prompt).not.toMatch(/===== docs\/\S+\.md =====/)
    }
  })

  it('honors an explicit k', () => {
    expect(buildRetrievedSystemPrompt('How is the platform fee split?', 2).chunks).toHaveLength(2)
  })

  it('never throws, whatever the question', () => {
    for (const question of ['', ' ', 'a'.repeat(2000), 'router '.repeat(400), '<script>']) {
      expect(() => buildRetrievedSystemPrompt(question)).not.toThrow()
    }
  })
})
