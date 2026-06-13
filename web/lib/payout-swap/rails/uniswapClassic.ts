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
 * @warn BOOTH-CONFIRM the zkSync Trading API `/swap` payload, the Universal Router address, and
 *   whether Blink's originator RPC covers zkSync at the event.
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

/** Shape of the classic `/quote` response we depend on (subset). */
interface ClassicQuoteResponse {
  amountOut: string
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
        body: JSON.stringify({
          chainId: req.chainId,
          tokenIn: req.usdc,
          tokenOut: req.payoutToken,
          amountIn: req.amountUsdc.toString(),
          swapper: req.merchant,
        }),
      })
      if (!res.ok) throw new Error(`Uniswap classic /quote failed (${res.status})`)
      const body = (await res.json()) as ClassicQuoteResponse
      if (!body.amountOut) throw new Error('Uniswap classic /quote returned no amountOut')
      return { amountOut: BigInt(body.amountOut) }
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
