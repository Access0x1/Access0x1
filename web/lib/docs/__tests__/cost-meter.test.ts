/**
 * @file cost-meter.test.ts — the documentation assistant's spend meter.
 *
 * Pins the three things the cost decision rests on:
 *  - the stream-frame parser pulls all four token counts out of realistic
 *    `message_start` / `message_delta` frames and ignores everything else,
 *  - the ring buffer stays bounded at 50 and evicts oldest-first,
 *  - the hit-rate arithmetic is right at 0%, at the 21.74% BREAK-EVEN (where
 *    with-cache spend must equal without-cache spend — the whole point of the
 *    meter), and at 100%.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  CACHE_BREAK_EVEN_HIT_RATE,
  COST_RING_CAPACITY,
  DOCS_ASK_DAILY_REQUEST_CAP,
  EMPTY_USAGE,
  HAIKU_4_5_PRICES,
  __resetDocsAskCostMeterForTests,
  answerCostUsd,
  classifyCache,
  mergeUsageFrame,
  readCostRecords,
  recordAnswerUsage,
  summarizeCost,
  type AnswerCostRecord,
  type AnswerUsage,
} from '../cost-meter.js'

/** The corpus prefix, in tokens — the number the cache multipliers act on. */
const PREFIX_TOKENS = 130_000
/** A short question, present on every turn, cached or not. */
const QUESTION_TOKENS = 12
/** A typical grounded answer, well under the 1024-token ceiling. */
const ANSWER_TOKENS = 150

/** A cache-MISS turn: the corpus is written into the cache at 1.25x. */
function writeUsage(): AnswerUsage {
  return {
    inputTokens: QUESTION_TOKENS,
    outputTokens: ANSWER_TOKENS,
    cacheCreationInputTokens: PREFIX_TOKENS,
    cacheReadInputTokens: 0,
  }
}

/** A cache-HIT turn: the corpus is read back from the cache at 0.1x. */
function readUsage(): AnswerUsage {
  return {
    inputTokens: QUESTION_TOKENS,
    outputTokens: ANSWER_TOKENS,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: PREFIX_TOKENS,
  }
}

/** Cost a synthetic mix of hits and misses without touching the ring buffer. */
function summarizeMix(reads: number, writes: number) {
  const records: AnswerCostRecord[] = []
  for (let i = 0; i < reads; i++) records.push(costed(readUsage()))
  for (let i = 0; i < writes; i++) records.push(costed(writeUsage()))
  return summarizeCost(records)
}

/** Turn raw usage into a record the way {@link recordAnswerUsage} would. */
function costed(usage: AnswerUsage): AnswerCostRecord {
  return { ...usage, ts: 0, cacheState: classifyCache(usage), costUsd: answerCostUsd(usage) }
}

beforeEach(() => {
  __resetDocsAskCostMeterForTests()
})

describe('mergeUsageFrame — the frames the streaming loop used to discard', () => {
  it('pulls all four counts out of a realistic cache-read message_start', () => {
    const frame = {
      type: 'message_start',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [],
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 130_412,
        },
      },
    }

    expect(mergeUsageFrame(EMPTY_USAGE, frame)).toEqual({
      inputTokens: 12,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 130_412,
    })
  })

  it('treats message_delta output_tokens as the CUMULATIVE total, not an increment', () => {
    const start = mergeUsageFrame(EMPTY_USAGE, {
      type: 'message_start',
      message: { usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 130_412 } },
    })
    const final = mergeUsageFrame(start, {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 187 },
    })

    // Replaced, never summed: 187 rather than 1 + 187.
    expect(final.outputTokens).toBe(187)
    // The input side from message_start survives a delta that omits it.
    expect(final.inputTokens).toBe(12)
    expect(final.cacheCreationInputTokens).toBe(130_412)
  })

  it('keeps the accumulator across null cache fields and non-usage frames', () => {
    const start = mergeUsageFrame(EMPTY_USAGE, {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 130_424,
          output_tokens: 1,
          // Anthropic reports null (not 0) on a turn with no cache block.
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
    })
    expect(start.cacheCreationInputTokens).toBe(0)
    expect(start.cacheReadInputTokens).toBe(0)

    // The text frames the user actually sees carry no usage and change nothing.
    const afterText = mergeUsageFrame(start, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'The router never holds funds.' },
    })
    expect(afterText).toEqual(start)

    // Junk frames are inert too — the meter never throws into the stream loop.
    expect(mergeUsageFrame(start, undefined)).toEqual(start)
    expect(mergeUsageFrame(start, 'message_start')).toEqual(start)
    expect(mergeUsageFrame(start, { type: 'message_delta' })).toEqual(start)
  })

  it('classifies a read over a simultaneous write — the read carries the corpus', () => {
    expect(classifyCache(readUsage())).toBe('read')
    expect(classifyCache(writeUsage())).toBe('write')
    expect(classifyCache({ ...EMPTY_USAGE, inputTokens: 130_424 })).toBe('none')
    expect(
      classifyCache({ ...readUsage(), cacheCreationInputTokens: 200 }),
    ).toBe('read')
  })
})

describe('the ring buffer stays bounded', () => {
  it(`evicts oldest-first at ${COST_RING_CAPACITY} records`, () => {
    for (let i = 0; i < COST_RING_CAPACITY + 20; i++) {
      recordAnswerUsage({ ...writeUsage(), outputTokens: i })
    }

    const records = readCostRecords()
    expect(records).toHaveLength(COST_RING_CAPACITY)
    // The 20 oldest are gone: the window now starts at the 21st answer.
    expect(records[0].outputTokens).toBe(20)
    expect(records[records.length - 1].outputTokens).toBe(COST_RING_CAPACITY + 19)
  })

  it('drops usage that reported nothing, so a dead stream never skews the mean', () => {
    expect(recordAnswerUsage(EMPTY_USAGE)).toBeNull()
    expect(readCostRecords()).toHaveLength(0)
  })

  it('stores only numbers, a cache state, and a timestamp — never user content', () => {
    const record = recordAnswerUsage(readUsage())
    expect(record).not.toBeNull()
    expect(Object.keys(record as AnswerCostRecord).sort()).toEqual([
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'cacheState',
      'costUsd',
      'inputTokens',
      'outputTokens',
      'ts',
    ])
  })
})

describe('the cache pays off only above the break-even hit rate', () => {
  const inputRate = HAIKU_4_5_PRICES.inputUsdPerMTok / 1_000_000

  it('puts break-even at 0.25 / 1.15 ≈ 21.74%', () => {
    expect(CACHE_BREAK_EVEN_HIT_RATE).toBeCloseTo(0.25 / 1.15, 12)
    expect(CACHE_BREAK_EVEN_HIT_RATE).toBeCloseTo(0.217391, 6)
  })

  it('0% hit rate: every turn writes at 1.25x, so the cache block LOSES money', () => {
    const summary = summarizeMix(0, 10)

    expect(summary.hitRate).toBe(0)
    expect(summary.cacheWrites).toBe(10)
    // The whole loss is the 0.25x write premium on ten corpus prefixes.
    expect(summary.cacheSavingUsd).toBeCloseTo(-10 * PREFIX_TOKENS * inputRate * 0.25, 12)
    expect(summary.inputUsdWithCache).toBeGreaterThan(summary.inputUsdWithoutCache)
  })

  it('AT break-even (5 hits / 23 turns) with-cache spend EQUALS without-cache spend', () => {
    // 5/23 is the break-even rate exactly: 18 writes x 1.25 + 5 reads x 0.1 = 23 x 1.
    const summary = summarizeMix(5, 18)

    expect(summary.hitRate).toBeCloseTo(CACHE_BREAK_EVEN_HIT_RATE, 12)
    expect(summary.inputUsdWithCache).toBeCloseTo(summary.inputUsdWithoutCache, 12)
    expect(summary.cacheSavingUsd).toBeCloseTo(0, 12)
  })

  it('100% hit rate: every turn reads at 0.1x, a 90% saving on the prefix', () => {
    const summary = summarizeMix(10, 0)

    expect(summary.hitRate).toBe(1)
    expect(summary.cacheReads).toBe(10)
    expect(summary.cacheSavingUsd).toBeCloseTo(10 * PREFIX_TOKENS * inputRate * 0.9, 12)
  })

  it('excludes cache-free turns from the hit-rate denominator', () => {
    const records = [costed(readUsage()), costed({ ...EMPTY_USAGE, inputTokens: 130_424 })]
    const summary = summarizeCost(records)

    expect(summary.uncached).toBe(1)
    expect(summary.hitRate).toBe(1)
  })

  it('reports 0 across the board on an empty buffer rather than NaN', () => {
    const summary = summarizeCost([])

    expect(summary.count).toBe(0)
    expect(summary.hitRate).toBe(0)
    expect(summary.meanUsdPerAnswer).toBe(0)
    expect(summary.projectedDailyUsd).toBe(0)
  })
})

describe('per-answer cost and the daily projection', () => {
  it('prices a cache MISS at the 1.25x write multiplier', () => {
    const expected =
      QUESTION_TOKENS / 1_000_000 +
      (PREFIX_TOKENS * 1.25) / 1_000_000 +
      (ANSWER_TOKENS * 5) / 1_000_000

    expect(answerCostUsd(writeUsage())).toBeCloseTo(expected, 12)
  })

  it('prices a cache HIT at the 0.1x read multiplier — an order of magnitude cheaper', () => {
    expect(answerCostUsd(readUsage())).toBeLessThan(answerCostUsd(writeUsage()) / 10)
  })

  it('projects the daily bill by the mean answer against the route request cap', () => {
    const summary = summarizeMix(0, 4)

    expect(summary.meanUsdPerAnswer).toBeCloseTo(answerCostUsd(writeUsage()), 12)
    expect(summary.projectedDailyUsd).toBeCloseTo(
      summary.meanUsdPerAnswer * DOCS_ASK_DAILY_REQUEST_CAP,
      12,
    )
  })
})
