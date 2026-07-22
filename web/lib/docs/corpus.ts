/**
 * @file corpus.ts — the server-only loader for the Access0x1 documentation
 * corpus that grounds the documentation assistant (see app/api/docs-ask/route.ts).
 *
 * The raw Markdown is vendored into `corpus.generated.ts` at build time by
 * `scripts/gen-docs-corpus.mjs` (a committed codegen step — see that script for
 * why a runtime `../docs` read is NOT safe in a Next.js standalone bundle). This
 * module is the ONE place the cap policy and citation formatting live:
 *
 *  - It concatenates every `docs/*.md` into a single corpus string, each file
 *    prefixed with a `\n\n===== docs/<FILE> =====\n` header so the model can CITE
 *    the exact source filename for every claim.
 *  - It enforces a HARD BYTE CAP with NO SILENT TRUNCATION (doctrine: no silent
 *    caps). When the corpus would exceed {@link DEFAULT_MAX_BYTES} (overridable via
 *    `DOCS_CORPUS_MAX_BYTES`), whole trailing files are DROPPED rather than a file
 *    being cut mid-content, the drop is logged with `console.warn` at load, and the
 *    dropped list is exposed via {@link getDroppedDocs} — never silently omitted.
 *  - It composes the grounding system prompt via {@link buildDocsSystemPrompt}.
 *
 * The cap keeps the corpus comfortably inside Haiku's 200K-token context window
 * with room for the question and the answer: 600,000 bytes is roughly 150K–160K
 * tokens, and the whole authored corpus is well under that today.
 */
import { DOCS_CORPUS, type DocsCorpusEntry } from './corpus.generated.js'

/**
 * Default hard byte cap for the assembled corpus (~150K–160K tokens), safely
 * under Haiku's 200K-token window with headroom for the question + the answer.
 * Overridable at deploy time via `DOCS_CORPUS_MAX_BYTES` (names-only in
 * `.env.example`); a test uses a tiny override to exercise the drop path.
 */
export const DEFAULT_MAX_BYTES = 600_000

/** The assembled corpus plus the audit trail of what was kept vs dropped. */
export interface AssembledCorpus {
  /** The concatenated, header-prefixed corpus string fed to the model. */
  readonly text: string
  /** Filenames included in {@link text}, in order. */
  readonly includedFiles: readonly string[]
  /** Filenames dropped to honor the byte cap (empty in the normal case). */
  readonly droppedFiles: readonly string[]
  /** Byte length of {@link text} (UTF-8). */
  readonly bytes: number
  /** The effective byte cap that produced this assembly. */
  readonly maxBytes: number
}

/**
 * Resolve the effective byte cap. Reads `DOCS_CORPUS_MAX_BYTES` (a positive
 * integer number of bytes) and falls back to {@link DEFAULT_MAX_BYTES} when the
 * var is unset, blank, non-numeric, or non-positive — never a silent zero cap.
 */
function corpusMaxBytes(): number {
  const raw = (process.env.DOCS_CORPUS_MAX_BYTES ?? '').trim()
  if (raw === '') return DEFAULT_MAX_BYTES
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES
}

/** The per-file citation header, e.g. `\n\n===== docs/FAQ.md =====\n`. */
function header(file: string): string {
  return `\n\n===== docs/${file} =====\n`
}

/** UTF-8 byte length of a string (matches how the API meters the corpus). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * Concatenate the vendored docs into one corpus string under the byte cap. Files
 * are appended in their committed (filename-sorted) order; the FIRST file whose
 * inclusion would breach the cap — and every file after it — is dropped whole, so
 * a citation never points at a half-truncated body. Dropping is loud, never silent.
 */
function assemble(): AssembledCorpus {
  const maxBytes = corpusMaxBytes()
  let text = ''
  let bytes = 0
  let capped = false
  const includedFiles: string[] = []
  const droppedFiles: string[] = []

  for (const { file, content } of DOCS_CORPUS as readonly DocsCorpusEntry[]) {
    const chunk = header(file) + content
    const chunkBytes = byteLength(chunk)
    if (capped || bytes + chunkBytes > maxBytes) {
      // Once the cap is reached, drop this file and every file after it — whole,
      // never mid-content — so a citation can never point at a truncated body.
      capped = true
      droppedFiles.push(file)
      continue
    }
    text += chunk
    bytes += chunkBytes
    includedFiles.push(file)
  }

  if (droppedFiles.length > 0) {
    console.warn(
      `[docs/corpus] byte cap ${maxBytes} exceeded — dropped ${droppedFiles.length} of ` +
        `${DOCS_CORPUS.length} file(s): ${droppedFiles.join(', ')}. Included ${includedFiles.length}. ` +
        'Raise DOCS_CORPUS_MAX_BYTES or trim docs/ to include them (no silent truncation).',
    )
  }

  return { text, includedFiles, droppedFiles, bytes, maxBytes }
}

/**
 * Assemble ONCE at module load. The corpus is stable for the life of the process
 * (the vendored data does not change at runtime), so this both honors the doctrine
 * that the drop warning fires "at load" and lets the route build its cached system
 * prompt a single time. Re-imported fresh (vitest `resetModules`) it re-reads the
 * current `DOCS_CORPUS_MAX_BYTES`, which is how the cap is unit-tested.
 */
const ASSEMBLED: AssembledCorpus = assemble()

/** The concatenated, header-prefixed documentation corpus fed to the model. */
export function getDocsCorpus(): string {
  return ASSEMBLED.text
}

/** Filenames included in the assembled corpus, in order. */
export function getIncludedDocs(): readonly string[] {
  return ASSEMBLED.includedFiles
}

/** Filenames dropped to honor the byte cap (empty in the normal case). */
export function getDroppedDocs(): readonly string[] {
  return ASSEMBLED.droppedFiles
}

/** UTF-8 byte length of the assembled corpus. */
export function getDocsCorpusBytes(): number {
  return ASSEMBLED.bytes
}

/**
 * The grounding instruction for the documentation assistant. Kept as its own
 * export so a test can assert the route sends it and it can be reused verbatim.
 * It pins the model to the corpus, requires per-claim citations, forbids inventing
 * addresses/hashes/numbers/claims, and keeps the testnet-only, no-mainnet framing.
 */
export const DOCS_GROUNDING_INSTRUCTION = [
  'You are the Access0x1 documentation assistant. Answer questions ONLY from the ' +
    'documentation provided below.',
  '',
  'RULES — follow them exactly:',
  '1. Answer ONLY from the DOCUMENTATION below. Do not use outside knowledge and do ' +
    'not fill gaps with assumptions.',
  '2. Cite the source doc filename (for example, docs/FAQ.md) for each claim you make, ' +
    'using the "===== docs/<FILE> =====" headers that separate the documents below.',
  '3. When the answer is not in these docs, say plainly that you do not know and point ' +
    'the reader to the documentation index (docs/START-HERE.md). Never invent a contract ' +
    'address, a transaction hash, a number, or any claim to fill a gap.',
  '4. This is a testnet build. Never imply a mainnet deployment or a mainnet claim, and ' +
    'never present the in-repo engineering audit as a third-party audit.',
  '5. Be concise, direct, and plain. No hype, no emojis.',
].join('\n')

/**
 * Compose the full system prompt for the documentation assistant: the grounding
 * instruction, then the assembled corpus between clear DOCUMENTATION markers. The
 * route passes this once as a cache-controlled system block so the large, stable
 * corpus is prompt-cached across requests.
 */
export function buildDocsSystemPrompt(): string {
  return [
    DOCS_GROUNDING_INSTRUCTION,
    '',
    '=== DOCUMENTATION ===',
    getDocsCorpus(),
    '',
    '=== END DOCUMENTATION ===',
  ].join('\n')
}
