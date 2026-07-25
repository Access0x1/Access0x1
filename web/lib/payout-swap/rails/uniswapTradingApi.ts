/**
 * @file uniswapTradingApi.ts — Base rail: Uniswap Trading API (/quote then /order | /swap).
 *
 * Base's same-chain payout swap. The Trading API returns a quote, then either a gasless
 * UniswapX `/order` (filler-paid, MEV-protected — the headline rail) or a classic `/swap`
 * transaction. UniswapX `/order` runs its OWN auction, so Blink Recovery is NOT applied here
 * (it belongs only on the classic-/swap legs).
 *
 * Non-custodial: the merchant's wallet signs the order/permit; this client only shapes the
 * Trading API request/response. The HTTP transport is the injectable {@link FetchLike} seam so
 * the whole rail unit-tests offline against mocked Trading API JSON.
 *
 * @verified 2026-07-25 against the LIVE Trading API (trade-api.gateway.uniswap.org/v1) with a
 *   real key: the `/quote` request/response shapes below returned HTTP 200 with a CLASSIC
 *   routing on Base mainnet (read-only probe; no funds moved). Three findings baked in here:
 *   (1) `tokenInChainId`/`tokenOutChainId` are STRINGS and the amount field is `amount` —
 *   the previously assumed `{chainId, amountIn}` body 4xxes; (2) the 200 response nests the
 *   output under `quote.output.amount` (CLASSIC) or `quote.orderInfo.outputs[0]` (UniswapX) —
 *   there is no top-level `amountOut`; (3) Base Sepolia returns `ResourceNotFound: No quotes
 *   available` — the Trading API serves no testnet routing, so this rail is a MAINNET-ONLY
 *   capability and stays dormant on our testnet-only deployment (recorded in FEEDBACK.md).
 * @warn The execute leg needs the merchant's signature (Permit2 / UniswapX order signing) —
 *   that leg lives with the wallet owner, never this seam. `/swap_7702`'s REST path is still
 *   the assumed part (the RPC method `Swap7702` is verified in `@uniswap/client-trading`).
 */

import type {
  PayoutSwapClient,
  RailExecution,
  RailQuote,
  SwapRequest,
  UnsignedSwapTx,
} from '../types.js'

/** A fetch implementation (the global `fetch`, or a test mock). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * The `/quote` response subset we depend on, covering both routing families
 * (live-verified CLASSIC; UniswapX per the official reference).
 */
interface TradingApiQuoteResponse {
  /** CLASSIC | WRAP | UNWRAP | DUTCH_V2 | DUTCH_V3 | PRIORITY | DUTCH_LIMIT | … */
  routing?: string
  quote?: {
    /** CLASSIC family: the expected output leg. */
    output?: { token?: string; amount?: string }
    /** UniswapX family: the Dutch-auction order (no `output` field exists here). */
    orderInfo?: {
      outputs?: readonly { startAmount?: string; endAmount?: string }[]
    }
  }
  /** Permit2 payload — stripped before any execute call, handled by the wallet owner. */
  permitData?: unknown
  /** Permit-as-transaction variant — stripped the same way. */
  permitTransaction?: unknown
}

/** The `/swap` response: a ready-to-sign transaction (never a hash — nothing was submitted). */
interface TradingApiSwapResponse {
  swap?: { to?: string; from?: string; data?: string; value?: string; chainId?: number; gasLimit?: string }
  /** Some mocked/alternate paths respond with a landed hash; accepted when present. */
  txHash?: string
}

/**
 * The three execution options the Trading API gives (verified against Uniswap's own generated
 * client, `@uniswap/client-trading@0.5.15`: RPC methods `Order`, `Swap`, `Swap7702`), mapped to
 * the three Access0x1 flows:
 *  - `gasless`       → UniswapX `/order` — the BUSINESS flow (merchant payout swap, filler-paid).
 *  - `classic`       → `/swap` — the USER flow (a wallet-signed transaction).
 *  - `smart-account` → `/swap_7702` — the AGENT flow (EIP-7702 smart-account execution, e.g. the
 *    agent's MPC wallet). Exact REST path CONFIRM-from-portal-docs before live use (the RPC
 *    method name is verified; its REST mapping is the assumed part).
 */
export type UniswapExecutionMode = 'gasless' | 'classic' | 'smart-account'

/** REST route per execution mode (`/order` | `/swap` | `/swap_7702`). */
const ROUTE_FOR_MODE: Record<UniswapExecutionMode, string> = {
  gasless: 'order',
  classic: 'swap',
  'smart-account': 'swap_7702',
}

/** Config for the Trading API rail. The base URL is env/booth-sourced, never hardcoded. */
export interface UniswapTradingApiConfig {
  /** Trading API base URL (e.g. from `UNISWAP_TRADING_API_URL`). */
  readonly baseUrl: string
  /** Injected fetch (defaults to global in app boot; a mock in tests). */
  readonly fetchImpl: FetchLike
  /**
   * Prefer the gasless UniswapX `/order` route. When false, falls back to classic `/swap`.
   * Default true (the headline rail). UniswapX has its OWN MEV auction (no Blink here).
   * Superseded by `executionMode` when that is set.
   */
  readonly preferGasless?: boolean
  /** Explicit execution mode (wins over `preferGasless`). See {@link UniswapExecutionMode}. */
  readonly executionMode?: UniswapExecutionMode
}

/**
 * Pull the output amount out of a quote response, by routing family. UniswapX quotes use the
 * auction FLOOR (`outputs[0].endAmount`) — the worker's `minAmountOut` check must hold at the
 * worst-case fill, and the best-case `startAmount` could pass the floor then decay below it.
 */
function quotedAmountOut(body: TradingApiQuoteResponse): bigint | null {
  const classic = body.quote?.output?.amount
  if (classic) return BigInt(classic)
  const floor = body.quote?.orderInfo?.outputs?.[0]?.endAmount
  if (floor) return BigInt(floor)
  return null
}

/** Build the Base Uniswap Trading API rail client. */
export function createUniswapTradingApiClient(
  config: UniswapTradingApiConfig,
): PayoutSwapClient {
  const { baseUrl, fetchImpl, preferGasless = true, executionMode } = config
  const mode: UniswapExecutionMode = executionMode ?? (preferGasless ? 'gasless' : 'classic')

  return {
    rail: 'uniswap-trading-api',

    /**
     * Approval pre-check (`/check_approval` — shape matches the official reference exactly):
     * `{walletAddress, token, amount, chainId}` → `{requestId, approval}`. An absent
     * `approval` means the token is already approved; a present one is the ready-to-sign tx the
     * wallet owner submits BEFORE `execute`. Completes the documented quote→approval→swap flow.
     */
    async checkApproval(req: SwapRequest) {
      const res = await fetchImpl(`${baseUrl}/check_approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          walletAddress: req.merchant,
          token: req.usdc,
          amount: req.amountUsdc.toString(),
          chainId: req.chainId,
        }),
      })
      if (!res.ok) {
        throw new Error(`Uniswap Trading API /check_approval failed (${res.status})`)
      }
      const body = (await res.json()) as {
        approval?: { to: string; data: string; value?: string } | null
      }
      const approval = body.approval ?? null
      return { needed: approval !== null, approval }
    },

    /**
     * The canonical `/quote` request (live-verified 2026-07-25): chain ids travel as STRINGS
     * in `tokenInChainId`/`tokenOutChainId`, the input amount as `amount`, and `type` selects
     * exact-input pricing. The full response is carried on the returned quote so `execute`
     * can spread it back per the documented flow, without a second round-trip.
     */
    async quote(req: SwapRequest): Promise<RailQuote> {
      const res = await fetchImpl(`${baseUrl}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          swapper: req.merchant,
          tokenIn: req.usdc,
          tokenOut: req.payoutToken,
          tokenInChainId: String(req.chainId),
          tokenOutChainId: String(req.chainId),
          amount: req.amountUsdc.toString(),
          type: 'EXACT_INPUT',
          // classic mode FORCES a /swap-able route; the others let BEST_PRICE reach the
          // UniswapX auction (whose quote then routes to /order per the official rule).
          routingPreference: mode === 'classic' ? 'CLASSIC' : 'BEST_PRICE',
        }),
      })
      if (!res.ok) {
        throw new Error(`Uniswap Trading API /quote failed (${res.status})`)
      }
      const body = (await res.json()) as TradingApiQuoteResponse
      const amountOut = quotedAmountOut(body)
      if (amountOut === null) {
        throw new Error('Uniswap Trading API /quote returned no output amount')
      }
      // Carry the FULL response so execute() can spread it back (the API expects the quote
      // response fields in the execute body — never wrapped, never re-fetched).
      return { amountOut, raw: body } as RailQuote & { raw: TradingApiQuoteResponse }
    },

    /**
     * Execute = spread the quote response into the body (the documented flow), with
     * `permitData`/`permitTransaction` stripped — the wallet owner handles permits. The
     * endpoint is DERIVED from the quote's `routing` (the official rule: DUTCH_V2/V3/
     * PRIORITY → `/order`; CLASSIC/WRAP/UNWRAP/BRIDGE → `/swap`); the smart-account mode
     * overrides to `/swap_7702`. `/swap` answers with a READY-TO-SIGN transaction
     * (`{swap: {...}}`), surfaced as `unsignedTx`; a landed `txHash` is accepted where a
     * submitting path provides one.
     */
    async execute(req: SwapRequest, quote: RailQuote): Promise<RailExecution> {
      const raw = (quote as RailQuote & { raw?: TradingApiQuoteResponse }).raw ?? {}
      const uniswapX = /^(DUTCH|PRIORITY)/.test(raw.routing ?? '')
      const route =
        mode === 'smart-account' ? ROUTE_FOR_MODE[mode] : uniswapX ? 'order' : 'swap'
      const { permitData: _pd, permitTransaction: _pt, ...cleanQuote } = raw
      const res = await fetchImpl(`${baseUrl}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cleanQuote),
      })
      if (!res.ok) {
        throw new Error(`Uniswap Trading API /${route} failed (${res.status})`)
      }
      const body = (await res.json()) as TradingApiSwapResponse
      if (body.txHash) return { txHash: body.txHash, rail: 'uniswap-trading-api' }
      const swap = body.swap
      // Guard per the official reference: empty calldata means the quote expired server-side.
      if (!swap?.to || !swap.data || swap.data === '0x') {
        throw new Error(`Uniswap Trading API /${route} returned no executable transaction`)
      }
      return { unsignedTx: swap as UnsignedSwapTx, rail: 'uniswap-trading-api' }
    },
  }
}
