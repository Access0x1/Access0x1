/**
 * @file anyToken1inch.test.ts — the 1inch agent pay-with-any-token quote (mocked transport).
 *
 * Pins dormancy (unset ONEINCH_API_URL ⇒ no deps ⇒ null), the EXACT_INPUT quote mapping + outgoing
 * query (src/dst/amount/fee=0), the fail-fast invalid-args guards, and the HTTP/malformed error
 * paths — zero network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildOneInchQuoteDeps,
  OneInchQuoteError,
  quoteOneInch,
  toOneInchQuoteJson,
  type OneInchQuoteDeps,
} from '../anyToken1inch.js'

const WETH = '0x1111111111111111111111111111111111111111'
const USDC = '0x2222222222222222222222222222222222222222'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function depsReturning(body: unknown, status = 200): { deps: OneInchQuoteDeps; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(async () => json(body, status))
  return { deps: { baseUrl: 'https://api', fetchImpl }, fetchImpl }
}

describe('buildOneInchQuoteDeps — dormancy', () => {
  const prevUrl = process.env.ONEINCH_API_URL
  const prevKey = process.env.ONEINCH_API_KEY
  beforeEach(() => {
    delete process.env.ONEINCH_API_URL
    delete process.env.ONEINCH_API_KEY
  })
  afterEach(() => {
    if (prevUrl === undefined) delete process.env.ONEINCH_API_URL
    else process.env.ONEINCH_API_URL = prevUrl
    if (prevKey === undefined) delete process.env.ONEINCH_API_KEY
    else process.env.ONEINCH_API_KEY = prevKey
  })

  it('is undefined when ONEINCH_API_URL is unset', () => {
    expect(buildOneInchQuoteDeps()).toBeUndefined()
  })

  it('is populated when ONEINCH_API_URL is set', () => {
    process.env.ONEINCH_API_URL = 'https://api.1inch.dev/swap/v6.0/137'
    const deps = buildOneInchQuoteDeps()
    expect(deps?.baseUrl).toBe('https://api.1inch.dev/swap/v6.0/137')
  })
})

describe('quoteOneInch — mapping + outgoing request', () => {
  it('maps dstAmount to amountOut and sends src/dst/amount/fee=0', async () => {
    const { deps, fetchImpl } = depsReturning({ dstAmount: '995000' })
    const quote = await quoteOneInch({ chainId: 137, tokenIn: WETH, tokenOut: USDC, amountIn: 3000000000000000n }, deps)
    expect(quote).not.toBeNull()
    expect(quote!.amountOut).toBe(995000n)
    const url = new URL(String(fetchImpl.mock.calls[0][0]))
    expect(url.pathname.endsWith('/quote')).toBe(true)
    expect(url.searchParams.get('src')).toBe(WETH)
    expect(url.searchParams.get('dst')).toBe(USDC)
    expect(url.searchParams.get('amount')).toBe('3000000000000000')
    expect(url.searchParams.get('fee')).toBe('0')
  })

  it('returns null when dormant (no deps) but still validates args first', async () => {
    expect(await quoteOneInch({ chainId: 137, tokenIn: WETH, tokenOut: USDC, amountIn: 1n }, undefined)).toBeNull()
    await expect(
      quoteOneInch({ chainId: 137, tokenIn: 'nope', tokenOut: USDC, amountIn: 1n }, undefined),
    ).rejects.toBeInstanceOf(OneInchQuoteError)
  })
})

describe('quoteOneInch — fail-fast guards', () => {
  const { deps } = depsReturning({ dstAmount: '1' })
  const bad = [
    { chainId: 137, tokenIn: 'nope', tokenOut: USDC, amountIn: 1n },
    { chainId: 137, tokenIn: WETH, tokenOut: 'nope', amountIn: 1n },
    { chainId: 0, tokenIn: WETH, tokenOut: USDC, amountIn: 1n },
    { chainId: 137, tokenIn: WETH, tokenOut: USDC, amountIn: 0n },
  ]
  for (const [i, req] of bad.entries()) {
    it(`rejects invalid-args case ${i}`, async () => {
      await expect(quoteOneInch(req, deps)).rejects.toMatchObject({ reason: 'invalid-args' })
    })
  }
})

describe('quoteOneInch — upstream errors', () => {
  it('throws quote-http-error on a non-2xx status', async () => {
    const { deps } = depsReturning({ error: 'rate limited' }, 429)
    await expect(
      quoteOneInch({ chainId: 137, tokenIn: WETH, tokenOut: USDC, amountIn: 1n }, deps),
    ).rejects.toMatchObject({ reason: 'quote-http-error' })
  })

  it('throws quote-malformed-response when dstAmount is missing', async () => {
    const { deps } = depsReturning({ protocols: [] })
    await expect(
      quoteOneInch({ chainId: 137, tokenIn: WETH, tokenOut: USDC, amountIn: 1n }, deps),
    ).rejects.toMatchObject({ reason: 'quote-malformed-response' })
  })
})

describe('toOneInchQuoteJson', () => {
  it('renders bigints as decimal strings', () => {
    const jsonQuote = toOneInchQuoteJson({
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: 3000000000000000n,
      amountOut: 995000n,
      routeSummary: 'x',
    })
    expect(jsonQuote.amountIn).toBe('3000000000000000')
    expect(jsonQuote.amountOut).toBe('995000')
  })
})
