/**
 * @file uniswapTradingApi.ts — Base rail: Uniswap Trading API (/quote then /order | /swap).
 *
 * Base's same-chain payout swap. The Trading API returns a quote, then either a gasless
 * UniswapX `/order` (filler-paid, MEV-protected — the headline demo) or a classic `/swap`
 * transaction. UniswapX `/order` runs its OWN auction, so Blink Recovery is NOT applied here
 * (it belongs only on the classic-/swap legs).
 *
 * Non-custodial: the merchant's wallet signs the order/permit; this client only shapes the
 * Trading API request/response. The HTTP transport is the injectable {@link FetchLike} seam so
 * the whole rail unit-tests offline against mocked Trading API JSON.
 *
 * @warn BOOTH-CONFIRM the Trading API base URL, request body field names, and the
 *   `/quote` vs `/order` vs `/swap` selection at the event before any mainnet use.
 */

import type {
  PayoutSwapClient,
  RailExecution,
  RailQuote,
  SwapRequest,
} from '../types.js'

/** A fetch implementation (the global `fetch`, or a test mock). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Shape of the Trading API `/quote` response we depend on (subset). */
interface TradingApiQuote {
  /** Expected output amount, atomic in the output token's decimals, as a string. */
  amountOut: string
  /** Opaque routing payload echoed back into `/order` or `/swap`. */
  quoteId: string
}

/** Shape of the Trading API `/order` (gasless) or `/swap` response we depend on (subset). */
interface TradingApiExecution {
  /** The submitted transaction / order hash. */
  txHash: string
}

/** Config for the Trading API rail. The base URL is env/booth-sourced, never hardcoded. */
export interface UniswapTradingApiConfig {
  /** Trading API base URL (e.g. from `UNISWAP_TRADING_API_URL`). */
  readonly baseUrl: string
  /** Injected fetch (defaults to global in app boot; a mock in tests). */
  readonly fetchImpl: FetchLike
  /**
   * Prefer the gasless UniswapX `/order` route. When false, falls back to classic `/swap`.
   * Default true (the headline demo). UniswapX has its OWN MEV auction (no Blink here).
   */
  readonly preferGasless?: boolean
}

/** Build the Base Uniswap Trading API rail client. */
export function createUniswapTradingApiClient(
  config: UniswapTradingApiConfig,
): PayoutSwapClient {
  const { baseUrl, fetchImpl, preferGasless = true } = config

  return {
    rail: 'uniswap-trading-api',

    async quote(req: SwapRequest): Promise<RailQuote> {
      const res = await fetchImpl(`${baseUrl}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chainId: req.chainId,
          tokenIn: req.usdc,
          tokenOut: req.payoutToken,
          amountIn: req.amountUsdc.toString(),
          swapper: req.merchant,
        }),
      })
      if (!res.ok) {
        throw new Error(`Uniswap Trading API /quote failed (${res.status})`)
      }
      const body = (await res.json()) as TradingApiQuote
      if (!body.amountOut) throw new Error('Uniswap Trading API /quote returned no amountOut')
      // Carry the routing id on the quote so execute() can echo it without a second round-trip.
      return { amountOut: BigInt(body.amountOut), quoteId: body.quoteId } as RailQuote & {
        quoteId: string
      }
    },

    async execute(req: SwapRequest, quote: RailQuote): Promise<RailExecution> {
      const route = preferGasless ? 'order' : 'swap'
      const quoteId = (quote as RailQuote & { quoteId?: string }).quoteId
      const res = await fetchImpl(`${baseUrl}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId,
          swapper: req.merchant,
          // Belt-and-suspenders: pass the floor to the rail too (the worker also enforces it).
          minAmountOut: req.minAmountOut.toString(),
          // SOLE monetization is the on-chain router fee-split — App Kit/Trading-API fee = 0 (law #4).
          customFeeBps: 0,
        }),
      })
      if (!res.ok) {
        throw new Error(`Uniswap Trading API /${route} failed (${res.status})`)
      }
      const body = (await res.json()) as TradingApiExecution
      if (!body.txHash) throw new Error(`Uniswap Trading API /${route} returned no txHash`)
      return { txHash: body.txHash, rail: 'uniswap-trading-api' }
    },
  }
}
