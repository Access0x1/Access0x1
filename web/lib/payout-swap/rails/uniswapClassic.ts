/**
 * @file uniswapClassic.ts — zkSync Era rail: Uniswap classic /swap (Universal Router).
 *
 * App Kit and CCTP do NOT support zkSync, so the classic Trading-API `/swap` (Universal
 * Router) is the only same-chain payout rail there. Unlike UniswapX `/order`, a bare classic
 * `/swap` exposes the merchant to backrun MEV — so this is the ONE leg where optional
 * **Blink Recovery** applies: route the signed swap tx through BlinkLabs' originator RPC to
 * return backrun value to the merchant (non-custodial). A Blink liveness failure falls back to
 * the direct RPC — recovery is best-effort and NEVER blocks the swap (law #5).
 *
 * Non-custodial: the merchant wallet signs; the injected {@link FetchLike} (Trading API) and
 * {@link SubmitRawTx} (RPC, optionally Blink) seams keep the rail unit-testable offline.
 *
 * @warn The `/swap` leg below still carries the ASSUMED payload/response (`{rawTx}`) — the
 *   live API (verified 2026-07-25 on the Trading API rail) answers `/swap` with an UNSIGNED
 *   `{swap: {...}}` transaction, so this leg needs the merchant-signing seam before any live
 *   use. The rail is dormant today (no zkSync RPC env), and the Trading API serves no testnet
 *   routing at all — see uniswapTradingApi.ts `@verified` + FEEDBACK.md. The `/quote` leg IS
 *   canonical (fixed with the same live-verified shape as the Trading API rail).
 */

import type {
  PayoutSwapClient,
  RailExecution,
  RailQuote,
  SwapRequest,
} from '../types.js'
import type { FetchLike } from './uniswapTradingApi.js'

/** Shape of the classic `/swap` response we depend on (subset). */
interface ClassicSwapResponse {
  /** Expected output amount, atomic, as a string (echoed from the quote leg). */
  amountOut: string
  /** The unsigned/raw calldata transaction the merchant wallet must sign + submit. */
  rawTx: string
}

/** The canonical `/quote` response subset (CLASSIC routing nests the output on `quote`). */
interface ClassicQuoteResponse {
  quote?: { output?: { amount?: string } }
}

/**
 * Submit a merchant-signed raw transaction. The default impl is the direct chain RPC; when
 * Blink Recovery is enabled, the app injects the BlinkLabs originator RPC here instead. A
 * Blink-side throw is caught by the rail and retried on the direct RPC (best-effort recovery).
 *
 * @param rawTx The merchant-signed raw transaction (this client never signs — non-custodial).
 * @returns The landed transaction hash.
 */
export type SubmitRawTx = (rawTx: string) => Promise<string>

/** Config for the zkSync classic-swap rail. */
export interface UniswapClassicConfig {
  /** Trading API base URL (env/booth-sourced). */
  readonly baseUrl: string
  /** Injected fetch for the Trading API. */
  readonly fetchImpl: FetchLike
  /** Direct chain RPC submit (always present — the recovery fallback). */
  readonly submitDirect: SubmitRawTx
  /**
   * Optional Blink Recovery submit (BlinkLabs originator RPC). When present it is TRIED FIRST;
   * a throw (liveness risk) falls back to {@link UniswapClassicConfig.submitDirect}. Absent =
   * recovery off (direct RPC only).
   */
  readonly submitBlink?: SubmitRawTx
}

/** Build the zkSync Uniswap-classic rail client, with optional Blink Recovery on the swap leg. */
export function createUniswapClassicClient(
  config: UniswapClassicConfig,
): PayoutSwapClient {
  const { baseUrl, fetchImpl, submitDirect, submitBlink } = config

  return {
    rail: 'uniswap-classic',

    async quote(req: SwapRequest): Promise<RailQuote> {
      const res = await fetchImpl(`${baseUrl}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The canonical, live-verified shape (2026-07-25): STRING chain ids in
        // `tokenInChainId`/`tokenOutChainId`, the input as `amount`, CLASSIC forced so the
        // execute leg stays on `/swap` (the only route this rail's submit model serves).
        body: JSON.stringify({
          swapper: req.merchant,
          tokenIn: req.usdc,
          tokenOut: req.payoutToken,
          tokenInChainId: String(req.chainId),
          tokenOutChainId: String(req.chainId),
          amount: req.amountUsdc.toString(),
          type: 'EXACT_INPUT',
          routingPreference: 'CLASSIC',
        }),
      })
      if (!res.ok) throw new Error(`Uniswap classic /quote failed (${res.status})`)
      const body = (await res.json()) as ClassicQuoteResponse
      const amount = body.quote?.output?.amount
      if (!amount) throw new Error('Uniswap classic /quote returned no output amount')
      return { amountOut: BigInt(amount) }
    },

    async execute(req: SwapRequest, _quote: RailQuote): Promise<RailExecution> {
      const res = await fetchImpl(`${baseUrl}/swap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chainId: req.chainId,
          tokenIn: req.usdc,
          tokenOut: req.payoutToken,
          amountIn: req.amountUsdc.toString(),
          minAmountOut: req.minAmountOut.toString(),
          swapper: req.merchant,
          customFeeBps: 0, // sole monetization is the router fee-split (law #4).
        }),
      })
      if (!res.ok) throw new Error(`Uniswap classic /swap failed (${res.status})`)
      const body = (await res.json()) as ClassicSwapResponse
      if (!body.rawTx) throw new Error('Uniswap classic /swap returned no rawTx')

      // Blink Recovery on the classic leg: try the originator RPC, fall back to direct on any
      // Blink liveness failure. Recovery is purely additive — it never blocks the swap (law #5).
      const txHash = await submitWithRecovery(body.rawTx, submitDirect, submitBlink)
      return { txHash, rail: 'uniswap-classic' }
    },
  }
}

/**
 * Submit via Blink (if configured) with a direct-RPC fallback. A Blink throw is swallowed in
 * favor of the direct submit — the merchant's swap still lands; only the MEV-recovery upside is
 * lost. If the direct submit ALSO throws, that propagates (the worker isolates it as
 * `execute-failed`, leaving the merchant holding settled USDC).
 */
async function submitWithRecovery(
  rawTx: string,
  submitDirect: SubmitRawTx,
  submitBlink?: SubmitRawTx,
): Promise<string> {
  if (submitBlink) {
    try {
      return await submitBlink(rawTx)
    } catch {
      // Blink liveness risk → direct-RPC fallback (recovery is best-effort, never blocking).
    }
  }
  return submitDirect(rawTx)
}
