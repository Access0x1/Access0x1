/**
 * @file meter.route.test.ts — GET /api/docs-ask/meter, the assistant's cost meter.
 *
 * Pins the contract the cost decision reads:
 *  - env-gated: closed by default, 404 not_enabled until DOCS_ASK_METER_PUBLIC=true,
 *  - the derived aggregates (hit rate, mean cost, daily projection) match the
 *    buffered records, including at the 21.74% break-even where with-cache and
 *    without-cache spend must come out equal,
 *  - the payload carries NO user content — the reason this route can exist at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CACHE_BREAK_EVEN_HIT_RATE,
  DOCS_ASK_DAILY_REQUEST_CAP,
  __resetDocsAskCostMeterForTests,
  recordAnswerUsage,
  type AnswerUsage,
  type CostSummary,
} from '@/lib/docs/cost-meter.js'

const { GET } = await import('../route.js')

const PREFIX_TOKENS = 130_000
const QUESTION = 'Does the Access0x1 router ever hold merchant funds?'

/** A cache-HIT turn: the corpus prefix came back at the 0.1x read multiplier. */
const HIT: AnswerUsage = {
  inputTokens: 12,
  outputTokens: 150,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: PREFIX_TOKENS,
}

/** A cache-MISS turn: the corpus prefix was written at the 1.25x multiplier. */
const MISS: AnswerUsage = {
  inputTokens: 12,
  outputTokens: 150,
  cacheCreationInputTokens: PREFIX_TOKENS,
  cacheReadInputTokens: 0,
}

interface MeterBody {
  recent: { costUsd: number; cacheState: string }[]
  summary: CostSummary
  prices: { inputUsdPerMTok: number; cacheWriteMultiplier: number }
  dailyRequestCap: number
  bufferCapacity: number
}

beforeEach(() => {
  __resetDocsAskCostMeterForTests()
  vi.stubEnv('DOCS_ASK_METER_PUBLIC', 'true')
})

afterEach(() => {
  vi.unstubAllEnvs()
  __resetDocsAskCostMeterForTests()
})

describe('the env gate', () => {
  it('is closed by default — an unset flag returns 404 not_enabled', async () => {
    vi.stubEnv('DOCS_ASK_METER_PUBLIC', '')
    recordAnswerUsage(HIT)

    const res = await GET()

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found', code: 'not_enabled' })
  })

  it('needs the literal opt-in, not merely a truthy value', async () => {
    vi.stubEnv('DOCS_ASK_METER_PUBLIC', '1')
    expect((await GET()).status).toBe(404)
  })

  it('serves the meter, uncacheable, once explicitly enabled', async () => {
    const res = await GET()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

describe('the derived aggregates', () => {
  it('reports an empty buffer as zeros rather than NaN', async () => {
    const body = (await (await GET()).json()) as MeterBody

    expect(body.recent).toEqual([])
    expect(body.summary.count).toBe(0)
    expect(body.summary.hitRate).toBe(0)
    expect(body.summary.projectedDailyUsd).toBe(0)
    expect(body.dailyRequestCap).toBe(DOCS_ASK_DAILY_REQUEST_CAP)
  })

  it('projects the daily bill from the measured mean at the route request cap', async () => {
    recordAnswerUsage(MISS)
    recordAnswerUsage(HIT)

    const body = (await (await GET()).json()) as MeterBody

    expect(body.recent).toHaveLength(2)
    expect(body.summary.cacheWrites).toBe(1)
    expect(body.summary.cacheReads).toBe(1)
    expect(body.summary.hitRate).toBe(0.5)
    expect(body.summary.cumulativeUsd).toBeCloseTo(
      body.recent[0].costUsd + body.recent[1].costUsd,
      12,
    )
    expect(body.summary.projectedDailyUsd).toBeCloseTo(
      body.summary.meanUsdPerAnswer * DOCS_ASK_DAILY_REQUEST_CAP,
      12,
    )
    // Half the turns hit, comfortably above break-even, so the block pays off.
    expect(body.summary.hitRate).toBeGreaterThan(CACHE_BREAK_EVEN_HIT_RATE)
    expect(body.summary.cacheSavingUsd).toBeGreaterThan(0)
  })

  it('shows the cache exactly paying for itself at the break-even hit rate', async () => {
    // 5 hits in 23 turns IS the break-even: 18 x 1.25 + 5 x 0.1 = 23 x 1.
    for (let i = 0; i < 5; i++) recordAnswerUsage(HIT)
    for (let i = 0; i < 18; i++) recordAnswerUsage(MISS)

    const { summary } = (await (await GET()).json()) as MeterBody

    expect(summary.count).toBe(23)
    expect(summary.hitRate).toBeCloseTo(CACHE_BREAK_EVEN_HIT_RATE, 12)
    expect(summary.inputUsdWithCache).toBeCloseTo(summary.inputUsdWithoutCache, 12)
    expect(summary.cacheSavingUsd).toBeCloseTo(0, 12)
  })

  it('echoes the list prices every figure is derived from', async () => {
    const body = (await (await GET()).json()) as MeterBody

    expect(body.prices.inputUsdPerMTok).toBe(1)
    expect(body.prices.cacheWriteMultiplier).toBe(1.25)
  })
})

describe('privacy — a cost meter, never a request log', () => {
  it('carries no question text, no answer text, and no IP', async () => {
    recordAnswerUsage(HIT)
    recordAnswerUsage(MISS)

    const raw = await (await GET()).text()

    expect(raw).not.toContain(QUESTION)
    expect(raw).not.toContain('question')
    expect(raw).not.toContain('answer')
    expect(raw).not.toContain('10.0.0.1')
    // Every record key is a number, a cache state, or a timestamp.
    const body = JSON.parse(raw) as MeterBody
    for (const record of body.recent) {
      expect(Object.keys(record).sort()).toEqual([
        'cacheCreationInputTokens',
        'cacheReadInputTokens',
        'cacheState',
        'costUsd',
        'inputTokens',
        'outputTokens',
        'ts',
      ])
    }
  })
})
