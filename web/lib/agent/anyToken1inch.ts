/**
 * @file anyToken1inch.ts — the agent "pay-with-any-token" quote via 1inch (server-only).
 *
 * The 1inch twin of {@link ./anyTokenQuote.ts}. An autonomous agent (or a buyer) that wants to
 * pay in an arbitrary token asks 1inch: "for `amountIn` of `tokenIn`, how much `tokenOut` do I
 * get, and via what route?" — the 1inch Aggregation API's native EXACT_INPUT quote. Where the
 * Uniswap seam is EXACT_OUTPUT (fix the USDC target, get the token cost), this is the aggregator's
 * forward quote, so the two surfaces complement rather than duplicate.
 *
 * DORMANT-BY-DEFAULT: the transport (base URL + the bearer-key fetch) is sourced from the ONE
 * payout-swap env seam ({@link buildPayoutSwapDeps}) — this module never reads `process.env`
 * itself. When `ONEINCH_API_URL` is unset the factory returns `undefined`, {@link quoteOneInch}
 * returns `null`, and the agent pay path is exactly as today. Purely additive (doctrine law #5).
 *
 * FAIL-FAST vs FAIL-SOFT: {@link quoteOneInch} validates args at entry and throws a typed
 * {@link OneInchQuoteError} on malformed input or a bad 1inch response; the route wrapping it
 * maps every error to "no quote", never a blocked settlement.
 *
 * Server-only (guardrail #4/#7): the 1inch key rides the injected fetch, never the browser bundle.
 */

import { isAddress, type Address } from 'viem'

import { assertServerOnly } from './serverOnly.js'
import { buildPayoutSwapDeps } from '../payout-swap/deps-from-env.js'
import type { FetchLike } from '../payout-swap/rails/uniswapTradingApi.js'

assertServerOnly('anyToken1inch')

/** Why a 1inch any-token quote could not be produced (all caught fail-soft by the route). */
export type OneInchQuoteFailure =
  | 'invalid-args' // a required arg was missing/malformed — a caller bug, surfaced fail-fast.
  | 'quote-http-error' // 1inch returned a non-2xx status.
  | 'quote-malformed-response' // the 1inch body lacked the `dstAmount` we depend on.

/** Typed error thrown by {@link quoteOneInch}. The message never contains a secret (guardrail #7). */
export class OneInchQuoteError extends Error {
  /** The category of failure, for programmatic handling. */
  readonly reason: OneInchQuoteFailure
  constructor(reason: OneInchQuoteFailure, message: string) {
    super(message)
    this.name = 'OneInchQuoteError'
    this.reason = reason
  }
}

/** The transport a 1inch quote needs: the API base URL + a bearer-key fetch. */
export interface OneInchQuoteDeps {
  /** 1inch API base URL (from `ONEINCH_API_URL`, via the payout-swap env seam). */
  readonly baseUrl: string
  /** Fetch with the `Authorization: Bearer` header pre-injected (or plain fetch when no key). */
  readonly fetchImpl: FetchLike
}

/** A request for a 1inch EXACT_INPUT quote: how much `tokenOut` for `amountIn` of `tokenIn`. */
export interface OneInchQuoteRequest {
  /** The chain the swap settles on (a same-chain quote, not a bridge). */
  readonly chainId: number
  /** The input token the agent would pay in (e.g. WETH). Must be a 0x address. */
  readonly tokenIn: string
  /** The output token (e.g. settlement USDC). Must be a 0x address. */
  readonly tokenOut: string
  /** The input amount to quote, atomic in `tokenIn` decimals (positive). */
  readonly amountIn: bigint
}

/** A resolved 1inch quote. `amountOut` is the headline: what `amountIn` converts to. */
export interface OneInchQuote {
  /** The input token quoted. */
  readonly tokenIn: Address
  /** The output token quoted. */
  readonly tokenOut: Address
  /** The input amount quoted, atomic in `tokenIn` decimals. */
  readonly amountIn: bigint
  /** The expected output, atomic in `tokenOut` decimals. */
  readonly amountOut: bigint
  /** A short, non-secret route summary for logs/telemetry. */
  readonly routeSummary: string
}

/** A JSON-safe projection of {@link OneInchQuote} (bigints → decimal strings) for a response body. */
export interface OneInchQuoteJson {
  readonly tokenIn: string
  readonly tokenOut: string
  readonly amountIn: string
  readonly amountOut: string
  readonly routeSummary: string
}

/** The subset of the 1inch `/quote` response this module depends on (confirm from 1inch docs). */
interface OneInchQuoteResponse {
  /** Expected output amount, atomic in `tokenOut` decimals, as a string. */
  dstAmount?: string
  /** Optional protocols/route label. */
  protocols?: unknown
}

/**
 * Build the 1inch quote transport from the shared payout-swap env seam. Returns `undefined`
 * (dormant) when `ONEINCH_API_URL` is unset — the single dormancy switch. Never throws.
 */
export function buildOneInchQuoteDeps(): OneInchQuoteDeps | undefined {
  const oneInch = buildPayoutSwapDeps().oneInch
  if (!oneInch) return undefined
  return { baseUrl: oneInch.baseUrl, fetchImpl: oneInch.fetchImpl }
}

/** Fail-fast guards for {@link quoteOneInch}. Throws `OneInchQuoteError('invalid-args', …)`. */
function assertValidRequest(req: OneInchQuoteRequest): void {
  if (!isAddress(req.tokenIn)) {
    throw new OneInchQuoteError('invalid-args', 'tokenIn must be a valid 0x address')
  }
  if (!isAddress(req.tokenOut)) {
    throw new OneInchQuoteError('invalid-args', 'tokenOut must be a valid 0x address')
  }
  if (!Number.isInteger(req.chainId) || req.chainId <= 0) {
    throw new OneInchQuoteError('invalid-args', 'chainId must be a positive integer')
  }
  if (req.amountIn <= 0n) {
    throw new OneInchQuoteError('invalid-args', 'amountIn must be a positive integer amount')
  }
}

/**
 * Quote how much `tokenOut` an `amountIn` of `tokenIn` yields, via the 1inch Aggregation API.
 *
 * DORMANT when the transport env is absent: returns `null` (the agent path is unchanged).
 * STRICT otherwise: validates args fail-fast and throws {@link OneInchQuoteError} on malformed
 * input, a non-2xx status, or a response missing `dstAmount`.
 *
 * @param req  The quote request (tokenIn + tokenOut + chainId + amountIn).
 * @param deps Injected transport; defaults to {@link buildOneInchQuoteDeps}. `undefined` → `null`.
 */
export async function quoteOneInch(
  req: OneInchQuoteRequest,
  deps: OneInchQuoteDeps | undefined = buildOneInchQuoteDeps(),
): Promise<OneInchQuote | null> {
  assertValidRequest(req)
  if (!deps) return null

  const qs = new URLSearchParams({ src: req.tokenIn, dst: req.tokenOut, amount: req.amountIn.toString(), fee: '0' })
  const res = await deps.fetchImpl(`${deps.baseUrl}/quote?${qs.toString()}`, { method: 'GET' })
  if (!res.ok) {
    throw new OneInchQuoteError('quote-http-error', `1inch /quote failed (${res.status})`)
  }

  const body = (await res.json()) as OneInchQuoteResponse
  if (!body.dstAmount) {
    throw new OneInchQuoteError('quote-malformed-response', '1inch /quote returned no dstAmount')
  }

  const amountOut = BigInt(body.dstAmount)
  return {
    tokenIn: req.tokenIn as Address,
    tokenOut: req.tokenOut as Address,
    amountIn: req.amountIn,
    amountOut,
    routeSummary: `${req.amountIn.toString()} ${req.tokenIn} -> ${amountOut.toString()} ${req.tokenOut} via 1inch`,
  }
}

/** Project an {@link OneInchQuote} to a JSON-safe DTO (bigints → decimal strings) for a response. */
export function toOneInchQuoteJson(quote: OneInchQuote): OneInchQuoteJson {
  return {
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountIn: quote.amountIn.toString(),
    amountOut: quote.amountOut.toString(),
    routeSummary: quote.routeSummary,
  }
}
