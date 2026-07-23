/**
 * @file oneInch.ts — the 1inch aggregator payout-swap rail (Fusion gasless | classic /swap).
 *
 * A same-chain payout swap via the 1inch Swap API: `/quote` returns the expected output, then
 * either a gasless **Fusion** order (resolver-filled, MEV-protected) or a classic `/swap`
 * transaction the merchant wallet submits. Same shape as the Uniswap Trading API rail, so the
 * worker treats them identically — 1inch is simply the aggregator alternative on chains it covers.
 *
 * Non-custodial: the merchant's wallet signs the Fusion order / submits the classic swap tx; this
 * client only shapes the 1inch request/response. The HTTP transport is the injectable
 * {@link FetchLike} seam (the 1inch API key is injected by the caller's fetch — see
 * `deps-from-env.ts`'s bearer fetch), so the whole rail unit-tests offline against mocked JSON.
 *
 * ZERO ADDED FEE: `fee=0` on every 1inch call — the SOLE monetization is the on-chain router
 * fee-split (law #4), exactly like the Uniswap rail's `customFeeBps: 0`.
 *
 * @warn CONFIRM the 1inch API base URL, the `/quote` & `/swap` (& Fusion) paths, and the response
 *   field names (`dstAmount`, `tx.hash`) against the 1inch docs before any mainnet use — marked
 *   assumed-until-confirmed, like the Uniswap rail.
 */

import type { FetchLike } from './uniswapTradingApi.js'
import type { PayoutSwapClient, RailExecution, RailQuote, SwapRequest } from '../types.js'

/** Shape of the 1inch `/quote` response we depend on (subset). */
interface OneInchQuote {
  /** Expected output amount, atomic in the output token's decimals, as a string. */
  dstAmount: string
}

/** Shape of the 1inch `/swap` (classic) or Fusion order response we depend on (subset). */
interface OneInchExecution {
  /** The submitted swap transaction / Fusion order hash. */
  txHash: string
}

/** Config for the 1inch rail. The base URL is env-sourced, never hardcoded. */
export interface OneInchConfig {
  /** 1inch Swap API base URL, incl. the chain segment (e.g. from `ONEINCH_API_URL`). */
  readonly baseUrl: string
  /** Injected fetch — carries the `Authorization: Bearer <key>` header in prod, a mock in tests. */
  readonly fetchImpl: FetchLike
  /**
   * Prefer the gasless 1inch **Fusion** route. When false, falls back to the classic `/swap`.
   * Default true (the headline demo). Fusion runs its OWN resolver auction (no external MEV leg).
   */
  readonly preferFusion?: boolean
}

/** Build the 1inch aggregator rail client. */
export function createOneInchClient(config: OneInchConfig): PayoutSwapClient {
  const { baseUrl, fetchImpl, preferFusion = true } = config

  return {
    rail: 'one-inch',

    async quote(req: SwapRequest): Promise<RailQuote> {
      // 1inch classic quote is a GET with query params: src/dst/amount, integrator fee = 0.
      const qs = new URLSearchParams({
        src: req.usdc,
        dst: req.payoutToken,
        amount: req.amountUsdc.toString(),
        fee: '0',
      })
      const res = await fetchImpl(`${baseUrl}/quote?${qs.toString()}`, { method: 'GET' })
      if (!res.ok) {
        throw new Error(`1inch /quote failed (${res.status})`)
      }
      const body = (await res.json()) as OneInchQuote
      if (!body.dstAmount) throw new Error('1inch /quote returned no dstAmount')
      return { amountOut: BigInt(body.dstAmount) }
    },

    async execute(req: SwapRequest): Promise<RailExecution> {
      // Fusion (gasless order) vs classic /swap — the 1inch analog of Uniswap's /order vs /swap.
      const route = preferFusion ? 'fusion/orders' : 'swap'
      const qs = new URLSearchParams({
        src: req.usdc,
        dst: req.payoutToken,
        amount: req.amountUsdc.toString(),
        from: req.merchant,
        // Belt-and-suspenders: pass the slippage floor to 1inch too (the worker also enforces it).
        minReturnAmount: req.minAmountOut.toString(),
        receiver: req.merchant,
        // SOLE monetization is the on-chain router fee-split — 1inch integrator fee = 0 (law #4).
        fee: '0',
      })
      const res = await fetchImpl(`${baseUrl}/${route}?${qs.toString()}`, { method: 'GET' })
      if (!res.ok) {
        throw new Error(`1inch /${route} failed (${res.status})`)
      }
      const body = (await res.json()) as OneInchExecution
      if (!body.txHash) throw new Error(`1inch /${route} returned no txHash`)
      return { txHash: body.txHash, rail: 'one-inch' }
    },
  }
}
