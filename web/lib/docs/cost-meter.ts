/**
 * @file cost-meter.ts — the server-only spend meter for the documentation
 * assistant (see app/api/docs-ask/route.ts).
 *
 * The assistant sends the whole docs corpus as one `cache_control: ephemeral`
 * block. That block is billed at a 1.25x multiplier when Anthropic WRITES the
 * cache and 0.1x when it READS it, so the deployment only comes out ahead above
 * a specific cache hit rate ({@link CACHE_BREAK_EVEN_HIT_RATE}). Nothing in the
 * app read `usage` before this module existed, which left that hit rate — and
 * therefore the real bill — unmeasured. This module closes that gap:
 *
 *  - {@link mergeUsageFrame} pulls the four token counts out of the raw
 *    `message_start` / `message_delta` stream frames the route used to discard.
 *  - {@link recordAnswerUsage} appends one costed record to a bounded ring
 *    buffer pinned on `globalThis` (the same pattern the route's rate meters
 *    use, so the buffer survives a module reload and can never grow unbounded).
 *  - {@link summarizeCost} derives the hit rate, the mean cost per answer, the
 *    projected daily spend, and the with-cache vs without-cache comparison that
 *    answers the only question that matters: does the cache block pay for itself.
 *
 * PRIVACY: a record holds numbers, a cache state, and a timestamp. Question
 * text, answer text, IP addresses, and every other user-derived value stay OUT
 * of this module by construction — it is a cost meter, never a request log.
 */

/**
 * Anthropic LIST prices for `claude-haiku-4-5`, in USD per million tokens, plus
 * the prompt-caching multipliers applied to the cached portion of the input.
 * Sourced from Anthropic's published pricing (cached 2026-06-24): $1/MTok input,
 * $5/MTok output, cache WRITE 1.25x the input rate, cache READ 0.1x the input
 * rate. One definition, so every projection on the meter page moves together
 * with a price change.
 */
export const HAIKU_4_5_PRICES = {
  /** USD per million uncached input tokens. */
  inputUsdPerMTok: 1,
  /** USD per million output tokens. */
  outputUsdPerMTok: 5,
  /** Multiplier on the input rate for tokens written INTO the prompt cache. */
  cacheWriteMultiplier: 1.25,
  /** Multiplier on the input rate for tokens read FROM the prompt cache. */
  cacheReadMultiplier: 0.1,
} as const

/**
 * The cache hit rate at which prompt caching costs exactly what sending the same
 * prefix uncached would cost. Solve `(1 - h) * write + h * read = 1` for h:
 * `h = (write - 1) / (write - read)` = `0.25 / 1.15` ≈ 21.74%. BELOW this rate
 * the `cache_control` block is a net LOSS — the 1.25x writes outweigh the 0.1x
 * reads — which is the entire reason this meter exists.
 */
export const CACHE_BREAK_EVEN_HIT_RATE =
  (HAIKU_4_5_PRICES.cacheWriteMultiplier - 1) /
  (HAIKU_4_5_PRICES.cacheWriteMultiplier - HAIKU_4_5_PRICES.cacheReadMultiplier)

/**
 * How many recent answers the ring buffer keeps. Bounded on purpose: the meter
 * runs in a long-lived server process, so an unbounded history would be a slow
 * memory leak dressed up as telemetry.
 */
export const COST_RING_CAPACITY = 50

/**
 * The documentation assistant's hard per-UTC-day request ceiling, consumed BOTH
 * by the route's never-negative daily meter and by this module's daily spend
 * projection. Defined once here so the projection can never drift away from the
 * cap it projects against.
 */
export const DOCS_ASK_DAILY_REQUEST_CAP = 500

/** The four token counts Anthropic reports for one answer. */
export interface AnswerUsage {
  /** Uncached input tokens, billed at the plain input rate. */
  readonly inputTokens: number
  /** Output tokens, billed at the output rate. */
  readonly outputTokens: number
  /** Input tokens WRITTEN into the prompt cache, billed at 1.25x input. */
  readonly cacheCreationInputTokens: number
  /** Input tokens READ from the prompt cache, billed at 0.1x input. */
  readonly cacheReadInputTokens: number
}

/** A usage accumulator with every count at zero — the start of a stream. */
export const EMPTY_USAGE: AnswerUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
}

/**
 * How the prompt cache behaved for one answer: `read` (a hit — the corpus came
 * from cache at 0.1x), `write` (a miss that populated the cache at 1.25x), or
 * `none` (no cached tokens at all, e.g. a stream that died before its first
 * usage frame).
 */
export type CacheState = 'read' | 'write' | 'none'

/** One costed answer in the ring buffer. Carries NO user content. */
export interface AnswerCostRecord extends AnswerUsage {
  /** Epoch milliseconds at which the answer finished streaming. */
  readonly ts: number
  /** How the prompt cache behaved — see {@link CacheState}. */
  readonly cacheState: CacheState
  /** Total USD billed for this answer at {@link HAIKU_4_5_PRICES}. */
  readonly costUsd: number
}

/** The derived view of the buffer that the meter endpoint serves. */
export interface CostSummary {
  /** Answers currently in the buffer. */
  readonly count: number
  /** Records whose corpus prefix was READ from cache (the hits). */
  readonly cacheReads: number
  /** Records that WROTE the corpus prefix into the cache (the misses). */
  readonly cacheWrites: number
  /** Records with no cached tokens at all, excluded from the hit rate. */
  readonly uncached: number
  /** `cacheReads / (cacheReads + cacheWrites)`, or 0 with no cache activity. */
  readonly hitRate: number
  /** {@link CACHE_BREAK_EVEN_HIT_RATE}, echoed so a client needs no constant. */
  readonly breakEvenHitRate: number
  /** Total USD across every record in the buffer. */
  readonly cumulativeUsd: number
  /** Mean USD per answer, or 0 on an empty buffer. */
  readonly meanUsdPerAnswer: number
  /** Mean cost extrapolated to {@link DOCS_ASK_DAILY_REQUEST_CAP} answers. */
  readonly projectedDailyUsd: number
  /** INPUT-side USD actually billed, cache multipliers included. */
  readonly inputUsdWithCache: number
  /** INPUT-side USD the same prefixes would have cost with NO cache block. */
  readonly inputUsdWithoutCache: number
  /**
   * `inputUsdWithoutCache - inputUsdWithCache`. Positive means the cache block
   * is earning its keep; negative means the 1.25x writes are winning and the
   * block should come off; zero lands exactly on the break-even hit rate.
   */
  readonly cacheSavingUsd: number
}

/** Narrow an unknown value to a plain indexable object, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * Read one finite numeric field. Absent, null, and non-numeric all collapse to
 * undefined so the caller keeps whatever it already accumulated — Anthropic
 * sends `cache_creation_input_tokens: null` on uncached turns.
 */
function numberAt(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const raw = source?.[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

/**
 * Fold one raw stream frame into a usage accumulator.
 *
 * Two frame types carry usage and the route forwards neither to the client:
 * `message_start` reports the input side (uncached, cache-write, cache-read) at
 * the top of the answer, and `message_delta` reports the CUMULATIVE output count
 * as the answer lands. Both are absolute totals rather than increments, so a
 * present field REPLACES the accumulated value; every other frame — the
 * `content_block_delta` text the user actually sees included — passes through
 * untouched.
 *
 * @param acc - the usage accumulated so far, starting at {@link EMPTY_USAGE}.
 * @param event - one raw stream event, of any shape.
 * @returns the updated accumulator (a new object, never a mutation of `acc`).
 */
export function mergeUsageFrame(acc: AnswerUsage, event: unknown): AnswerUsage {
  const frame = asRecord(event)
  const type = frame?.['type']
  const usage =
    type === 'message_start'
      ? asRecord(asRecord(frame?.['message'])?.['usage'])
      : type === 'message_delta'
        ? asRecord(frame?.['usage'])
        : undefined
  if (!usage) return acc
  return {
    inputTokens: numberAt(usage, 'input_tokens') ?? acc.inputTokens,
    outputTokens: numberAt(usage, 'output_tokens') ?? acc.outputTokens,
    cacheCreationInputTokens:
      numberAt(usage, 'cache_creation_input_tokens') ?? acc.cacheCreationInputTokens,
    cacheReadInputTokens: numberAt(usage, 'cache_read_input_tokens') ?? acc.cacheReadInputTokens,
  }
}

/**
 * Classify the prompt-cache behavior of one answer. A READ wins over a
 * simultaneous write, because the read covers the large stable corpus prefix
 * while any concurrent write covers only the short tail beyond it — the read is
 * what makes the request cheap.
 *
 * @param usage - the answer's token counts.
 * @returns the cache state to store on the record.
 */
export function classifyCache(usage: AnswerUsage): CacheState {
  if (usage.cacheReadInputTokens > 0) return 'read'
  if (usage.cacheCreationInputTokens > 0) return 'write'
  return 'none'
}

/**
 * Total USD billed for one answer at {@link HAIKU_4_5_PRICES}: uncached input at
 * 1x, cache writes at 1.25x, cache reads at 0.1x, output at the output rate.
 *
 * @param usage - the answer's token counts.
 * @returns the cost in USD, full precision.
 */
export function answerCostUsd(usage: AnswerUsage): number {
  const inputRate = HAIKU_4_5_PRICES.inputUsdPerMTok / 1_000_000
  const outputRate = HAIKU_4_5_PRICES.outputUsdPerMTok / 1_000_000
  return (
    usage.inputTokens * inputRate +
    usage.cacheCreationInputTokens * inputRate * HAIKU_4_5_PRICES.cacheWriteMultiplier +
    usage.cacheReadInputTokens * inputRate * HAIKU_4_5_PRICES.cacheReadMultiplier +
    usage.outputTokens * outputRate
  )
}

/** INPUT-side USD actually billed for one answer, cache multipliers included. */
function inputUsdWithCache(usage: AnswerUsage): number {
  const inputRate = HAIKU_4_5_PRICES.inputUsdPerMTok / 1_000_000
  return (
    usage.inputTokens * inputRate +
    usage.cacheCreationInputTokens * inputRate * HAIKU_4_5_PRICES.cacheWriteMultiplier +
    usage.cacheReadInputTokens * inputRate * HAIKU_4_5_PRICES.cacheReadMultiplier
  )
}

/**
 * INPUT-side USD the SAME prefix would have cost with no `cache_control` block:
 * every input token, cached or not, at the plain 1x rate. The counterfactual the
 * break-even comparison is built on.
 */
function inputUsdWithoutCache(usage: AnswerUsage): number {
  const inputRate = HAIKU_4_5_PRICES.inputUsdPerMTok / 1_000_000
  return (
    (usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens) * inputRate
  )
}

// --- the ring buffer, pinned on globalThis under its OWN key so it survives a
//     module reload and never shares state with the route's rate meters ---
const GLOBAL_KEY = '__ax1_docs_ask_cost_meter__'

interface CostMeterState {
  records: AnswerCostRecord[]
}

function state(): CostMeterState {
  const g = globalThis as unknown as Record<string, CostMeterState | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { records: [] }
  return g[GLOBAL_KEY] as CostMeterState
}

/** True once at least one token was reported — an empty frame is not an answer. */
function hasUsage(usage: AnswerUsage): boolean {
  return (
    usage.inputTokens +
      usage.outputTokens +
      usage.cacheCreationInputTokens +
      usage.cacheReadInputTokens >
    0
  )
}

/**
 * Cost one answer and append it to the ring buffer, evicting the oldest record
 * beyond {@link COST_RING_CAPACITY}.
 *
 * Usage that reported nothing at all is DROPPED rather than stored: a stream
 * that failed before its first `message_start` produced no billable answer, and
 * a zero record would drag every average toward zero.
 *
 * @param usage - the accumulated token counts for one finished answer.
 * @returns the stored record, or null for usage that reported nothing.
 */
export function recordAnswerUsage(usage: AnswerUsage): AnswerCostRecord | null {
  if (!hasUsage(usage)) return null
  const record: AnswerCostRecord = {
    ...usage,
    ts: Date.now(),
    cacheState: classifyCache(usage),
    costUsd: answerCostUsd(usage),
  }
  const { records } = state()
  records.push(record)
  while (records.length > COST_RING_CAPACITY) records.shift()
  return record
}

/** The buffered records, oldest first. A snapshot — mutating it changes nothing. */
export function readCostRecords(): readonly AnswerCostRecord[] {
  return [...state().records]
}

/**
 * Derive the aggregates the meter endpoint serves from a set of records.
 *
 * @param records - the buffered answers, typically {@link readCostRecords}.
 * @param dailyRequestCap - answers per day to project against; defaults to the
 *   route's own {@link DOCS_ASK_DAILY_REQUEST_CAP}.
 * @returns the derived summary; every field is 0 on an empty buffer.
 */
export function summarizeCost(
  records: readonly AnswerCostRecord[],
  dailyRequestCap: number = DOCS_ASK_DAILY_REQUEST_CAP,
): CostSummary {
  const cacheReads = records.filter((r) => r.cacheState === 'read').length
  const cacheWrites = records.filter((r) => r.cacheState === 'write').length
  const uncached = records.length - cacheReads - cacheWrites
  const cacheTurns = cacheReads + cacheWrites
  const cumulativeUsd = records.reduce((sum, r) => sum + r.costUsd, 0)
  const meanUsdPerAnswer = records.length > 0 ? cumulativeUsd / records.length : 0
  const withCache = records.reduce((sum, r) => sum + inputUsdWithCache(r), 0)
  const withoutCache = records.reduce((sum, r) => sum + inputUsdWithoutCache(r), 0)
  return {
    count: records.length,
    cacheReads,
    cacheWrites,
    uncached,
    hitRate: cacheTurns > 0 ? cacheReads / cacheTurns : 0,
    breakEvenHitRate: CACHE_BREAK_EVEN_HIT_RATE,
    cumulativeUsd,
    meanUsdPerAnswer,
    projectedDailyUsd: meanUsdPerAnswer * dailyRequestCap,
    inputUsdWithCache: withCache,
    inputUsdWithoutCache: withoutCache,
    cacheSavingUsd: withoutCache - withCache,
  }
}

/**
 * Test-only: empty the globalThis-pinned ring buffer so each test starts from a
 * clean meter. Production never calls this.
 */
export function __resetDocsAskCostMeterForTests(): void {
  const g = globalThis as unknown as Record<string, CostMeterState | undefined>
  g[GLOBAL_KEY] = { records: [] }
}
