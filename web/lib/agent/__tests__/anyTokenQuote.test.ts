/**
 * @file anyTokenQuote.test.ts — offline unit tests for the agent pay-with-any-token quote seam.
 *
 * Hermetic: the Trading-API transport is injected as a mock {@link FetchLike}, so no network is
 * ever touched. These pin the four contract guarantees:
 *   - DORMANT when the transport env is absent (factory → undefined, quoteAnyToken → null),
 *   - correct quote-shape MAPPING from the Trading-API `/quote` body,
 *   - FAIL-FAST typed guards on malformed args, and
 *   - HTTP/response errors surface as typed throws (the route turns these fail-soft).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  quoteAnyToken,
  buildAnyTokenQuoteDeps,
  toAnyTokenQuoteJson,
  AnyTokenQuoteError,
  type AnyTokenQuoteDeps,
  type AnyTokenQuoteRequest,
} from '../anyTokenQuote.js'
import type { FetchLike } from '../../payout-swap/rails/uniswapTradingApi.js'

const TOKEN_IN = '0x2222222222222222222222222222222222222222' as const // token X (e.g. WETH)
const USDC = '0x1111111111111111111111111111111111111111' as const // settlement token (tokenOut)
const SWAPPER = '0x3333333333333333333333333333333333333333' as const // the paying agent

/**
 * A Trading API `/quote` response in the live-verified CLASSIC shape (2026-10-01, EXACT_OUTPUT on
 * Ethereum Sepolia): the cost is nested at `quote.input.amount` and the id at `quote.quoteId`.
 * There is no top-level `amountIn`, and a CLASSIC quote carries no expiry.
 */
function quoteBody(amountIn: string, quoteId = 'q'): unknown {
  return {
    routing: 'CLASSIC',
    quote: { input: { amount: amountIn }, output: { amount: '1000000' }, quoteId },
  }
}

/** Build a JSON Response like the app runtime does. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A valid request quoting a $1.00 payment (→ 1_000_000 USDC base units) priced in token X. */
function validReq(over: Partial<AnyTokenQuoteRequest> = {}): AnyTokenQuoteRequest {
  return { chainId: 84532, tokenIn: TOKEN_IN, tokenOut: USDC, usdAmount: 1.0, swapper: SWAPPER, ...over }
}

/** Deps whose fetch returns a fixed Trading-API `/quote` body. */
function depsReturning(body: unknown, status = 200): { deps: AnyTokenQuoteDeps; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn<FetchLike>(async () => json(body, status))
  return { deps: { baseUrl: 'https://trade.example/v1', fetchImpl }, fetchImpl }
}

describe('buildAnyTokenQuoteDeps — dormant unless the Trading-API env is present', () => {
  const KEYS = ['UNISWAP_TRADING_API_URL', 'UNISWAP_TRADING_API_KEY'] as const
  const snap: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of KEYS) {
      snap[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (snap[k] === undefined) delete process.env[k]
      else process.env[k] = snap[k]
    }
  })

  it('returns undefined when UNISWAP_TRADING_API_URL is unset (the single dormancy switch)', () => {
    expect(buildAnyTokenQuoteDeps()).toBeUndefined()
  })

  it('returns the base URL + a fetch once UNISWAP_TRADING_API_URL is set', () => {
    process.env.UNISWAP_TRADING_API_URL = 'https://trade.example/v1'
    const deps = buildAnyTokenQuoteDeps()
    expect(deps?.baseUrl).toBe('https://trade.example/v1')
    expect(typeof deps?.fetchImpl).toBe('function')
  })
})

describe('quoteAnyToken — dormant path', () => {
  it('returns null (no quote) when deps are absent — the agent path is unchanged', async () => {
    const res = await quoteAnyToken(validReq(), undefined)
    expect(res).toBeNull()
  })

  it('validates args BEFORE dormancy: a malformed request throws even with no deps', async () => {
    await expect(quoteAnyToken(validReq({ tokenIn: 'nope' }), undefined)).rejects.toBeInstanceOf(
      AnyTokenQuoteError,
    )
  })
})

describe('quoteAnyToken — quote-shape mapping', () => {
  it('maps the Trading-API /quote body to a typed AnyTokenQuote (amountIn is the cost in token X)', async () => {
    const { deps, fetchImpl } = depsReturning(quoteBody('250000000000000000', 'q-abc')) // 0.25 WETH
    const res = await quoteAnyToken(validReq(), deps)
    expect(res).not.toBeNull()
    expect(res!.amountIn).toBe(250000000000000000n)
    expect(res!.amountOut).toBe(1_000_000n) // $1.00 → 6-dec USDC base units
    expect(res!.tokenIn).toBe(TOKEN_IN)
    expect(res!.tokenOut).toBe(USDC)
    expect(res!.expiresAtSec).toBe(0) // a CLASSIC quote carries no expiry
    expect(res!.quoteId).toBe('q-abc')
    expect(res!.routeSummary).toContain('CLASSIC')
    expect(res!.routeSummary).toContain('250000000000000000')

    // EXACT_OUTPUT request shaping: the settlement (tokenOut) amount is fixed, token X is the input.
    const call = fetchImpl.mock.calls[0]!
    expect(String(call[0])).toBe('https://trade.example/v1/quote')
    const sent = JSON.parse((call[1] as RequestInit).body as string)
    expect(sent.type).toBe('EXACT_OUTPUT')
    expect(sent.tokenIn).toBe(TOKEN_IN)
    expect(sent.tokenOut).toBe(USDC)
    expect(sent.amount).toBe('1000000')
    // The canonical body the live API accepts: chain ids as STRINGS under tokenInChainId /
    // tokenOutChainId, and a swapper. A bare `chainId` answers HTTP 400 `"tokenInChainId" is
    // required`; a missing swapper answers `"swapper" is required` (both probed 2026-10-01).
    expect(sent.tokenInChainId).toBe('84532')
    expect(sent.tokenOutChainId).toBe('84532')
    expect('chainId' in sent).toBe(false)
    expect(sent.swapper).toBe(SWAPPER)
    // AMM-only, so the response is always the CLASSIC shape this module parses.
    expect(sent.routingPreference).toBe('BEST_PRICE')
    expect(sent.protocols).toEqual(['V2', 'V3', 'V4'])
  })

  it('accepts an explicit tokenOutAmount instead of usdAmount', async () => {
    const { deps, fetchImpl } = depsReturning(quoteBody('5', 'q2'))
    const res = await quoteAnyToken(
      validReq({ usdAmount: undefined, tokenOutAmount: 2_500_000n }),
      deps,
    )
    expect(res!.amountOut).toBe(2_500_000n)
    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(sent.amount).toBe('2500000')
  })

  it('reports expiresAtSec 0 — the CLASSIC quote this module requests carries no expiry', async () => {
    const { deps } = depsReturning(quoteBody('5', 'q3'))
    const res = await quoteAnyToken(validReq(), deps)
    expect(res!.expiresAtSec).toBe(0)
  })
})

describe('quoteAnyToken — fail-fast malformed-arg guards', () => {
  const bad: Array<[string, Partial<AnyTokenQuoteRequest>]> = [
    ['non-address tokenIn', { tokenIn: 'nope' }],
    ['non-address tokenOut', { tokenOut: '0x123' }],
    ['zero chainId', { chainId: 0 }],
    ['non-integer chainId', { chainId: 1.5 }],
    ['non-address swapper', { swapper: 'nope' }],
    ['missing swapper', { swapper: undefined }],
    ['neither amount', { usdAmount: undefined, tokenOutAmount: undefined }],
    ['both amounts', { usdAmount: 1, tokenOutAmount: 1n }],
    ['zero usdAmount', { usdAmount: 0 }],
    ['negative usdAmount', { usdAmount: -1 }],
    ['non-finite usdAmount', { usdAmount: Number.POSITIVE_INFINITY }],
    ['zero tokenOutAmount', { usdAmount: undefined, tokenOutAmount: 0n }],
  ]
  for (const [name, over] of bad) {
    it(`throws AnyTokenQuoteError(invalid-args) on ${name}`, async () => {
      const { deps } = depsReturning(quoteBody('5'))
      await expect(quoteAnyToken(validReq(over), deps)).rejects.toMatchObject({
        name: 'AnyTokenQuoteError',
        reason: 'invalid-args',
      })
    })
  }
})

describe('quoteAnyToken — Trading-API error surfacing (route turns these fail-soft)', () => {
  it('throws quote-http-error on a non-2xx status', async () => {
    const { deps } = depsReturning({ error: 'rate limited' }, 429)
    await expect(quoteAnyToken(validReq(), deps)).rejects.toMatchObject({ reason: 'quote-http-error' })
  })

  it('throws quote-malformed-response when quote.input.amount is missing', async () => {
    const { deps } = depsReturning({ routing: 'CLASSIC', quote: { output: { amount: '1000000' }, quoteId: 'q' } })
    await expect(quoteAnyToken(validReq(), deps)).rejects.toMatchObject({
      reason: 'quote-malformed-response',
    })
  })

  it('does NOT read the old flat shape: a top-level amountIn is not a quote', async () => {
    // The shape this module used to parse. The live API never returns it, so accepting it
    // would only let a mock pass where production fails.
    const { deps } = depsReturning({ amountIn: '5', quoteId: 'q' })
    await expect(quoteAnyToken(validReq(), deps)).rejects.toMatchObject({
      reason: 'quote-malformed-response',
    })
  })

  it('throws quote-malformed-response on a non-integer amount rather than a raw SyntaxError', async () => {
    const { deps } = depsReturning(quoteBody('1.5'))
    await expect(quoteAnyToken(validReq(), deps)).rejects.toMatchObject({
      reason: 'quote-malformed-response',
    })
  })

  it('does not swallow a transport rejection (the strict primitive rethrows)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error('network down')
    })
    await expect(quoteAnyToken(validReq(), { baseUrl: 'https://x', fetchImpl })).rejects.toThrow(
      'network down',
    )
  })
})

describe('toAnyTokenQuoteJson — bigints render as strings for the HTTP body', () => {
  it('projects every bigint to a decimal string and preserves the rest', async () => {
    const { deps } = depsReturning(quoteBody('250000000000000000', 'q'))
    const quote = await quoteAnyToken(validReq(), deps)
    const dto = toAnyTokenQuoteJson(quote!)
    expect(dto.amountIn).toBe('250000000000000000')
    expect(dto.amountOut).toBe('1000000')
    expect(dto.expiresAtSec).toBe(0)
    expect(dto.quoteId).toBe('q')
    // Must be JSON-serializable (no bigint) — proves it can sit in a Response body.
    expect(() => JSON.stringify(dto)).not.toThrow()
  })
})
