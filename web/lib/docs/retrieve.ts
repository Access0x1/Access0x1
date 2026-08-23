/**
 * @file retrieve.ts — BM25 retrieval over the documentation corpus, so the
 * assistant sends the passages a question is ABOUT instead of every passage
 * that exists (see app/api/docs-ask/route.ts).
 *
 * WHY this module exists: the whole-corpus prompt is ~496KB of text on every
 * question, and prompt caching only pays for itself above a ~21.74% hit rate
 * (lib/docs/cost-meter.ts). Retrieval removes that conditionality — sending a
 * few thousand tokens costs the same warm or cold, so the saving no longer
 * depends on traffic shape or on a five-minute cache TTL.
 *
 * WHY BM25 and nothing else: the corpus is ~500 short chunks held in memory in
 * a process that already loads them. Ranking them is a scoring loop, not an
 * infrastructure problem. Embeddings would add a metered API call to every
 * question — converting a free lever into a per-request cost on hits AND
 * misses — and a retrieval framework would add dependencies to a `web/` that
 * carries exactly one AI dependency today. BM25 is the whole algorithm, in
 * standard form, with ZERO new dependencies.
 *
 * WHAT it indexes: the per-file entries that survived the corpus byte cap
 * ({@link getIncludedDocEntries}), split on Markdown headings so a chunk is a
 * section a human would have linked to. Every chunk keeps its source filename,
 * so the citation rule in {@link DOCS_GROUNDING_INSTRUCTION} resolves exactly
 * as it does in whole-corpus mode.
 *
 * The index is built ONCE at module load. The corpus is vendored at build time
 * and never changes at runtime, so a rebuild per request would burn CPU to
 * produce a byte-identical result.
 */
import { DOCS_GROUNDING_INSTRUCTION, getIncludedDocEntries } from './corpus.js'

/**
 * BM25 term-frequency saturation. 1.2 is the standard setting: a term's tenth
 * occurrence in a chunk adds far less than its second, which is what stops a
 * long section from outranking a precise one by sheer repetition.
 */
export const BM25_K1 = 1.2

/**
 * BM25 length normalization. 0.75 is the standard setting: it discounts long
 * chunks most of the way toward their length, without the full penalty that
 * `b = 1` applies — the docs mix 300-byte notes with 9KB reference tables and
 * both must stay reachable.
 */
export const BM25_B = 0.75

/** Chunks returned per question by default — the plan's measured top-8. */
export const DEFAULT_TOP_K = 8

/**
 * The score below which a chunk counts as noise rather than a match.
 *
 * Derived, not guessed: with 517 chunks a term appearing in ONE of them scores
 * roughly 8, while a term appearing in more than half of them scores under 0.5.
 * A chunk that clears this floor therefore shares at least one term that is not
 * ubiquitous in the corpus; a chunk below it matched only on words every
 * document contains, which is no evidence of relevance at all.
 */
export const MIN_CHUNK_SCORE = 0.5

/**
 * Hard UTF-8 byte ceiling on the assembled retrieval prompt.
 *
 * The point of retrieval is a bounded bill, so the bound is enforced rather
 * than hoped for: passages are admitted highest-score-first while the running
 * total stays under this figure, and the first one that would breach it ends
 * the set. At ~3.6–4.0 bytes per token this caps a retrieval prompt near
 * 3,500–3,900 tokens worst case, against ~130,000 for the whole corpus. A
 * typical top-8 (mean chunk 956 bytes, measured) lands around 9,100 bytes.
 */
export const RETRIEVED_PROMPT_BYTE_CEILING = 14_000

/** One retrievable section of one documentation file. */
export interface DocChunk {
  /** Source filename, e.g. `FAQ.md` — what a citation names. */
  readonly file: string
  /** The chunk's Markdown heading, or the file's name for a preamble chunk. */
  readonly heading: string
  /** The chunk body, verbatim Markdown, heading line included. */
  readonly text: string
}

/** A chunk with the BM25 score it earned for one question. */
export interface ScoredChunk {
  /** The chunk itself. */
  readonly chunk: DocChunk
  /** Its BM25 score. Higher is more relevant; never below {@link MIN_CHUNK_SCORE}. */
  readonly score: number
}

/**
 * Split text into lowercase alphanumeric terms.
 *
 * Deliberately free of a stopword list: BM25's IDF already collapses the weight
 * of a term that appears everywhere, so a hand-maintained stopword list would
 * add a file to keep in sync in exchange for an effect the formula already has.
 * Digits survive because chain ids, ERC numbers, and version strings are some of
 * the most discriminating terms in this corpus.
 *
 * @param text - any text, question or document.
 * @returns the terms, in order, duplicates included.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/**
 * Split one document into heading-delimited chunks.
 *
 * Splits before every H1/H2/H3 line, so a chunk is one section plus everything
 * under it up to the next heading of that depth or shallower — the unit a
 * human would have linked to. Text before the first heading becomes its own
 * chunk rather than being dropped.
 *
 * @param file - the source filename, carried onto every chunk for citation.
 * @param content - the document's verbatim Markdown.
 * @returns the chunks, in document order; empty sections are discarded.
 */
export function chunkDocument(file: string, content: string): DocChunk[] {
  const chunks: DocChunk[] = []
  for (const part of content.split(/\n(?=#{1,3} )/)) {
    const text = part.trim()
    if (text.length === 0) continue
    const heading = text.split('\n', 1)[0].replace(/^#{1,3}\s*/, '').trim()
    chunks.push({ file, heading: heading.length > 0 ? heading : file, text })
  }
  return chunks
}

/** One chunk's occurrence count for one term. */
interface Posting {
  /** Index into {@link CHUNKS}. */
  readonly chunk: number
  /** How many times the term occurs in that chunk. */
  readonly freq: number
}

/** The inverted index plus the length statistics BM25 normalizes against. */
interface Bm25Index {
  /** term -> the chunks containing it, with per-chunk frequency. */
  readonly postings: Map<string, Posting[]>
  /** Term count per chunk, parallel to {@link CHUNKS}. */
  readonly lengths: number[]
  /** Mean term count across all chunks; 1 for an empty corpus (never a divide by zero). */
  readonly avgLength: number
}

/** Every chunk of every included document, built once at module load. */
const CHUNKS: readonly DocChunk[] = getIncludedDocEntries().flatMap((entry) =>
  chunkDocument(entry.file, entry.content),
)

/**
 * Build the inverted index. One pass over the corpus: tokenize each chunk, fold
 * its terms into per-chunk frequency counts, then append one posting per
 * distinct term. Postings land in ascending chunk order because the outer loop
 * walks chunks in order, which is what makes scoring deterministic.
 */
function buildIndex(chunks: readonly DocChunk[]): Bm25Index {
  const postings = new Map<string, Posting[]>()
  const lengths: number[] = []
  let totalLength = 0

  chunks.forEach((chunk, index) => {
    const terms = tokenize(chunk.text)
    lengths.push(terms.length)
    totalLength += terms.length
    const freqs = new Map<string, number>()
    for (const term of terms) freqs.set(term, (freqs.get(term) ?? 0) + 1)
    for (const [term, freq] of freqs) {
      const list = postings.get(term)
      if (list === undefined) postings.set(term, [{ chunk: index, freq }])
      else list.push({ chunk: index, freq })
    }
  })

  return { postings, lengths, avgLength: chunks.length > 0 ? totalLength / chunks.length : 1 }
}

const INDEX: Bm25Index = buildIndex(CHUNKS)

/**
 * Every chunk the retriever can return, in corpus order.
 *
 * @returns the indexed chunks. A snapshot of a frozen structure — the index is
 *   immutable for the life of the process.
 */
export function getDocChunks(): readonly DocChunk[] {
  return CHUNKS
}

/**
 * Inverse document frequency, in the BM25+ non-negative form
 * `ln(1 + (N - df + 0.5) / (df + 0.5))`.
 *
 * The classic Robertson/Sparck-Jones form goes NEGATIVE for a term carried by
 * more than half the corpus, which lets a common word subtract score from a
 * chunk that genuinely matches a rare one. This form floors at zero instead, so
 * a common term contributes little and never harms.
 *
 * @param docFreq - how many chunks contain the term.
 * @param total - the number of chunks in the index.
 * @returns the term's weight.
 */
function idf(docFreq: number, total: number): number {
  return Math.log(1 + (total - docFreq + 0.5) / (docFreq + 0.5))
}

/**
 * Rank the corpus against a question and return the best chunks.
 *
 * Scores every chunk that shares at least one term with the question, keeps
 * those clearing {@link MIN_CHUNK_SCORE}, and returns the top `k`. Ties break
 * toward the earlier chunk, so the same question always produces the same set
 * and a retrieval regression shows up as a diff rather than as flake.
 *
 * A question with no usable terms — blank, punctuation, emoji — matches nothing
 * and yields an EMPTY array. That is the honest answer, and the caller treats
 * it as such rather than answering from an empty context.
 *
 * @param question - the user's raw question text.
 * @param k - how many chunks to return; defaults to {@link DEFAULT_TOP_K}.
 * @returns the scored chunks, best first; empty when nothing clears the floor.
 */
export function topK(question: string, k: number = DEFAULT_TOP_K): ScoredChunk[] {
  const limit = Number.isFinite(k) && k > 0 ? Math.floor(k) : DEFAULT_TOP_K
  const total = CHUNKS.length
  if (total === 0) return []

  const scores = new Map<number, number>()
  for (const term of new Set(tokenize(question))) {
    const list = INDEX.postings.get(term)
    if (list === undefined) continue
    const weight = idf(list.length, total)
    for (const { chunk, freq } of list) {
      const norm = 1 - BM25_B + (BM25_B * INDEX.lengths[chunk]) / INDEX.avgLength
      const contribution = (weight * (freq * (BM25_K1 + 1))) / (freq + BM25_K1 * norm)
      scores.set(chunk, (scores.get(chunk) ?? 0) + contribution)
    }
  }

  return [...scores.entries()]
    .filter(([, score]) => score >= MIN_CHUNK_SCORE)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([chunk, score]) => ({ chunk: CHUNKS[chunk], score }))
}

/**
 * The honesty preface that fronts a retrieval prompt.
 *
 * Whole-corpus mode hands the model everything, so "not in the docs" and "not in
 * the prompt" mean the same thing there. Retrieval breaks that equivalence: a
 * fact can be documented and simply absent from this question's passages. Left
 * unsaid, the model would treat the excerpt as the whole corpus and answer a
 * near-miss question with confident nonsense. Saying it restores rule 3 of
 * {@link DOCS_GROUNDING_INSTRUCTION} — admit the gap, name the doc index.
 */
export const RETRIEVAL_SCOPE_NOTE = [
  'SCOPE: the DOCUMENTATION below is the subset of the Access0x1 docs retrieved for THIS ' +
    'question — the passages ranked most relevant, NOT the complete documentation set.',
  'A fact absent here may still be documented elsewhere. Rule 3 governs: when these passages ' +
    'do not contain the answer, say plainly that you do not know and point the reader to ' +
    'docs/START-HERE.md. Never fill the gap from outside knowledge.',
].join('\n')

/** A system prompt built for one question, with the evidence behind it. */
export interface RetrievedPrompt {
  /** The system prompt to send: grounding instruction, scope note, passages. */
  readonly prompt: string
  /**
   * Whether retrieval found anything worth sending. FALSE means the question
   * matched nothing above {@link MIN_CHUNK_SCORE} — the caller must fall back
   * rather than ask the model to answer from an empty context.
   */
  readonly matched: boolean
  /** The passages included, best first. Empty exactly when `matched` is false. */
  readonly chunks: readonly ScoredChunk[]
  /** UTF-8 byte length of {@link prompt}; never above {@link RETRIEVED_PROMPT_BYTE_CEILING}. */
  readonly bytes: number
}

/** UTF-8 byte length. Matches how the API meters a prompt. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The per-passage citation header, byte-identical to whole-corpus mode's
 * (lib/docs/corpus.ts) so citation rule 2 resolves the same way in both modes.
 */
function passageHeader(file: string): string {
  return `\n\n===== docs/${file} =====\n`
}

/**
 * Build the system prompt for one question out of its top-ranked passages.
 *
 * The grounding instruction and the scope note are ALWAYS present — a prompt
 * that lost its rules would be a prompt that invents addresses — and passages
 * are admitted best-first while the total stays under
 * {@link RETRIEVED_PROMPT_BYTE_CEILING}. The first passage that would breach the
 * ceiling ends the set: a whole section is dropped rather than cut mid-content,
 * so a citation can never point at a truncated body (the same no-silent-
 * truncation rule the corpus loader follows).
 *
 * NOT cache-controlled by design. The prompt differs per question, so a cache
 * write would be paid on every request and read back on none — a 1.25x
 * multiplier bought for nothing. The only stable prefix left after retrieval is
 * the instruction block, which is far under Anthropic's minimum cacheable
 * prefix anyway.
 *
 * @param question - the user's raw question text.
 * @param k - how many passages to consider; defaults to {@link DEFAULT_TOP_K}.
 * @returns the prompt plus the evidence and the match verdict behind it.
 */
export function buildRetrievedSystemPrompt(question: string, k: number = DEFAULT_TOP_K): RetrievedPrompt {
  const preamble = [DOCS_GROUNDING_INSTRUCTION, '', RETRIEVAL_SCOPE_NOTE, '', '=== DOCUMENTATION ==='].join('\n')
  const postamble = '\n\n=== END DOCUMENTATION ==='
  const budget = RETRIEVED_PROMPT_BYTE_CEILING - byteLength(preamble) - byteLength(postamble)

  const chunks: ScoredChunk[] = []
  let passages = ''
  let used = 0
  for (const hit of topK(question, k)) {
    const passage = passageHeader(hit.chunk.file) + hit.chunk.text
    const cost = byteLength(passage)
    // Budget exhausted: stop admitting rather than trim this passage in half.
    if (used + cost > budget) break
    passages += passage
    used += cost
    chunks.push(hit)
  }

  const prompt = preamble + passages + postamble
  return { prompt, matched: chunks.length > 0, chunks, bytes: byteLength(prompt) }
}
