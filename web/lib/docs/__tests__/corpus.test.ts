/**
 * @file corpus.test.ts — pins the documentation corpus loader contract.
 *
 *  - the assembled corpus is non-empty and carries a `===== docs/<FILE> =====`
 *    citation header for every included doc,
 *  - under the default cap the WHOLE vendored corpus is included and nothing is
 *    dropped,
 *  - a tiny `DOCS_CORPUS_MAX_BYTES` override enforces the cap, reports the dropped
 *    files, and warns at load — NO silent truncation (repo law),
 *  - the system prompt contains the grounding instruction and at least one known
 *    doc filename, with the testnet-only framing intact.
 *
 * The loader assembles ONCE at module load, so the cap test stubs the env, resets
 * the module registry, and re-imports to re-run the assembly under the small cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A doc that must exist in the vendored corpus (used as the citation probe). */
const KNOWN_DOC = 'FAQ.md'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('default config — the whole corpus fits under the cap', () => {
  it('assembles a non-empty corpus with a per-file header for every included doc', async () => {
    const mod = await import('../corpus.js')
    const corpus = mod.getDocsCorpus()

    expect(corpus.length).toBeGreaterThan(0)
    expect(corpus).toContain(`===== docs/${KNOWN_DOC} =====`)
    for (const file of mod.getIncludedDocs()) {
      expect(corpus).toContain(`===== docs/${file} =====`)
    }
  })

  it('includes every vendored doc and drops none, staying under the default cap', async () => {
    const mod = await import('../corpus.js')
    const { DOCS_CORPUS } = await import('../corpus.generated.js')

    expect(mod.getIncludedDocs().length).toBe(DOCS_CORPUS.length)
    expect(mod.getDroppedDocs()).toEqual([])
    expect(mod.getDocsCorpusBytes()).toBeLessThanOrEqual(mod.DEFAULT_MAX_BYTES)
  })
})

describe('hard byte cap — no silent truncation', () => {
  it('drops trailing files, reports them, warns at load, and accounts for every doc', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 40 KB admits the first (largest, sorted-first) doc and forces the rest out,
    // so we assert a genuine mix of included AND dropped — not an all-or-nothing.
    vi.stubEnv('DOCS_CORPUS_MAX_BYTES', '40000')
    vi.resetModules()

    const mod = await import('../corpus.js')
    const { DOCS_CORPUS } = await import('../corpus.generated.js')

    expect(mod.getIncludedDocs().length).toBeGreaterThan(0)
    expect(mod.getDroppedDocs().length).toBeGreaterThan(0)
    // Included + dropped account for every vendored file — nothing silently vanishes.
    expect(mod.getIncludedDocs().length + mod.getDroppedDocs().length).toBe(DOCS_CORPUS.length)
    // The assembled corpus honors the cap.
    expect(mod.getDocsCorpusBytes()).toBeLessThanOrEqual(40000)
    // The drop is LOUD (a single console.warn at load), never silent.
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('dropped')
    expect(message).toContain('DOCS_CORPUS_MAX_BYTES')
    // Every reported drop names a real vendored file.
    const dropped = new Set(mod.getDroppedDocs())
    const known = new Set(DOCS_CORPUS.map((d) => d.file))
    for (const file of dropped) expect(known.has(file)).toBe(true)
  })
})

describe('system prompt', () => {
  it('contains the grounding instruction and at least one known doc filename', async () => {
    const mod = await import('../corpus.js')
    const prompt = mod.buildDocsSystemPrompt()

    expect(prompt).toContain('documentation assistant')
    expect(prompt.toLowerCase()).toContain('answer only from')
    expect(prompt).toContain('Cite the source doc filename')
    expect(prompt).toContain('=== DOCUMENTATION ===')
    expect(prompt).toContain(`===== docs/${KNOWN_DOC} =====`)
    // Testnet-only framing intact; the prompt never promises mainnet.
    expect(prompt.toLowerCase()).toContain('testnet')
  })
})
