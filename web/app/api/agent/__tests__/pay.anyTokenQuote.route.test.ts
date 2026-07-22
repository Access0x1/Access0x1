/**
 * @file pay.anyTokenQuote.route.test.ts — the OPTIONAL any-token quote on POST /api/agent/pay.
 *
 * The quote is additive telemetry: it must NEVER change or block the USDC settlement. These
 * tests drive the route with the settlement path mocked (wallet + x402 wrapper) and the quote's
 * transport driven through a stubbed global `fetch` (the quote's keyed fetch calls the global).
 * They prove:
 *   - env UNSET (dormant) with `quoteToken` present → response byte-identical (no `quote`),
 *   - `quoteToken` ABSENT with the seam live → still no `quote`,
 *   - seam LIVE + `quoteToken` → the 200 carries a correctly-shaped `quote` (single + nano-loop),
 *   - a quote FETCH FAILURE → settlement still 200, no `quote` (fail-soft, law #5).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { POST } from '../pay/route.js'
import {
  setWrapFetchWithPayment,
  setBaseFetchForTests,
} from '../../../../lib/agent/payPerCall.js'
import { __resetMeterForTests } from '../../../../lib/agent/agentMeter.js'
import {
  setDynamicClientFactory,
  __resetWalletForTests,
  type DynamicEvmWalletClient,
  type AgentAccount,
} from '../../../../lib/agent/dynamicAgentWallet.js'

const ACCT: AgentAccount = {
  accountAddress: '0xAGENT0000000000000000000000000000000abc',
  publicKeyHex: '0xpub',
  walletId: 'wallet-1',
}

const ALLOWED = 'http://localhost:3000/api/premium/quote'
const TOKEN_IN = '0x2222222222222222222222222222222222222222' // token X the agent prices in
const USDC = '0x1111111111111111111111111111111111111111' // settlement token (AGENT_QUOTE_USDC)

function installWalletMock(): void {
  const client: DynamicEvmWalletClient = {
    authenticateApiToken: vi.fn().mockResolvedValue(undefined),
    createWalletAccount: vi.fn().mockResolvedValue(ACCT),
    getWalletAccount: vi.fn().mockResolvedValue(ACCT),
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    signMessage: vi.fn().mockResolvedValue('0xsig'),
  }
  setDynamicClientFactory((() => client) as never)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function req(body: unknown): Request {
  return new Request('http://localhost:3000/api/agent/pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Enable the any-token quote seam (Trading-API transport + settlement chain + its USDC). */
function enableQuoteEnv(): void {
  process.env.UNISWAP_TRADING_API_URL = 'https://trade.example/v1'
  process.env.AGENT_QUOTE_CHAIN_ID = '84532'
  process.env.AGENT_QUOTE_USDC = USDC
}

describe('POST /api/agent/pay — optional any-token quote', () => {
  beforeEach(() => {
    __resetMeterForTests()
    __resetWalletForTests()
    process.env.DYNAMIC_ENVIRONMENT_ID = 'env-123'
    process.env.DYNAMIC_AUTH_TOKEN = 'tok-abc'
    process.env.WALLET_PASSWORD = 'pw'
    process.env.AGENT_DAILY_USD_CAP = '5.00'
    process.env.AGENT_URL_ALLOWLIST = 'http://localhost:3000'
    process.env.AGENT_ALLOW_INSECURE = 'true'
    delete process.env.AGENT_INTERNAL_SECRET
    delete process.env.AGENT_WALLET_ID
    // Quote seam OFF by default; individual tests opt in via enableQuoteEnv().
    delete process.env.UNISWAP_TRADING_API_URL
    delete process.env.UNISWAP_TRADING_API_KEY
    delete process.env.AGENT_QUOTE_CHAIN_ID
    delete process.env.AGENT_QUOTE_USDC
    installWalletMock()
    setWrapFetchWithPayment((() => async () => jsonResponse({ quote: 'ok' })) as never)
  })

  afterEach(() => {
    setWrapFetchWithPayment(null)
    setBaseFetchForTests(null)
    setDynamicClientFactory(null)
    __resetMeterForTests()
    __resetWalletForTests()
    vi.unstubAllGlobals()
    delete process.env.AGENT_ALLOW_INSECURE
    delete process.env.UNISWAP_TRADING_API_URL
    delete process.env.AGENT_QUOTE_CHAIN_ID
    delete process.env.AGENT_QUOTE_USDC
  })

  it('dormant (env unset) + quoteToken present → 200 with NO quote field (unchanged)', async () => {
    const spy = vi.fn(async () => jsonResponse({ amountIn: '1', quoteId: 'q' }))
    vi.stubGlobal('fetch', spy)
    const res = await POST(req({ url: ALLOWED, quoteToken: TOKEN_IN }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.result).toEqual({ quote: 'ok' })
    expect('quote' in body).toBe(false)
    // Dormant means the quote leg never even reaches the transport.
    expect(spy).not.toHaveBeenCalled()
  })

  it('seam live but NO quoteToken → 200 with no quote field (quote is opt-in per request)', async () => {
    enableQuoteEnv()
    const spy = vi.fn(async () => jsonResponse({ amountIn: '1', quoteId: 'q' }))
    vi.stubGlobal('fetch', spy)
    const res = await POST(req({ url: ALLOWED }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect('quote' in body).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('seam live + quoteToken → 200 result + a correctly-shaped quote', async () => {
    enableQuoteEnv()
    const spy = vi.fn(async (url: string) => {
      expect(url).toBe('https://trade.example/v1/quote')
      return jsonResponse({ amountIn: '250000000000000000', quoteId: 'q-abc', routing: 'UniswapX', deadline: 42 })
    })
    vi.stubGlobal('fetch', spy)
    const res = await POST(req({ url: ALLOWED, quoteToken: TOKEN_IN, pricePerCallUsd: 0.001 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result).toEqual({ quote: 'ok' }) // settlement UNTOUCHED
    expect(body.quote).toBeDefined()
    expect(body.quote.tokenIn).toBe(TOKEN_IN)
    expect(body.quote.tokenOut).toBe(USDC)
    expect(body.quote.amountIn).toBe('250000000000000000') // cost in token X, serialized
    expect(body.quote.amountOut).toBe('1000') // $0.001 → 1000 USDC base units
    expect(body.quote.quoteId).toBe('q-abc')
    expect(spy).toHaveBeenCalledOnce()
  })

  it('seam live + quoteToken on a nano-loop → 200 results + quote', async () => {
    enableQuoteEnv()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ amountIn: '9', quoteId: 'q' })))
    const res = await POST(req({ url: ALLOWED, count: 3, pricePerCallUsd: 0.001, quoteToken: TOKEN_IN }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(3)
    expect(body.quote.amountIn).toBe('9')
  })

  it('quote FETCH FAILURE → settlement still 200, no quote (fail-soft, law #5)', async () => {
    enableQuoteEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('trading api down')
      }),
    )
    const res = await POST(req({ url: ALLOWED, quoteToken: TOKEN_IN }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.result).toEqual({ quote: 'ok' })
    expect('quote' in body).toBe(false)
  })

  it('quote HTTP 500 → settlement still 200, no quote (fail-soft)', async () => {
    enableQuoteEnv()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'boom' }, 500)))
    const res = await POST(req({ url: ALLOWED, quoteToken: TOKEN_IN }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect('quote' in body).toBe(false)
  })

  it('malformed quoteToken (not an address) → settlement still 200, no quote (fail-soft)', async () => {
    enableQuoteEnv()
    const spy = vi.fn(async () => jsonResponse({ amountIn: '1', quoteId: 'q' }))
    vi.stubGlobal('fetch', spy)
    const res = await POST(req({ url: ALLOWED, quoteToken: 'not-an-address' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect('quote' in body).toBe(false)
    // The malformed token fails fast inside quoteAnyToken, before any transport call.
    expect(spy).not.toHaveBeenCalled()
  })

  it('seam live but AGENT_QUOTE_* config missing → no quote (settlement unaffected)', async () => {
    process.env.UNISWAP_TRADING_API_URL = 'https://trade.example/v1' // transport live…
    // …but no AGENT_QUOTE_CHAIN_ID / AGENT_QUOTE_USDC → the route skips the quote.
    const spy = vi.fn(async () => jsonResponse({ amountIn: '1', quoteId: 'q' }))
    vi.stubGlobal('fetch', spy)
    const res = await POST(req({ url: ALLOWED, quoteToken: TOKEN_IN }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect('quote' in body).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
