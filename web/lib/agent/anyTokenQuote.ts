/**
 * @file anyTokenQuote.ts — the agent "pay-with-any-token" quote seam (server-only).
 *
 * An autonomous agent settles a payment in USDC (the untouched x402/EIP-3009 core). This
 * module lets it ALSO ask, on the same request, "what does this payment cost in token X?" —
 * i.e. how much of an arbitrary input token is worth the USDC the payment settles. The
 * answer comes from the Uniswap Trading API `/quote` (EXACT_OUTPUT: tokenOut = settlement
 * USDC, so the returned `amountIn` is the cost in token X).
 *
 * DORMANT-BY-DEFAULT: the transport (base URL + the `x-api-key`-injecting fetch) is sourced
 * from the ONE payout-swap env seam ({@link buildPayoutSwapDeps}) — this module never reads
 * `process.env` itself, so it does not duplicate that idiom. When `UNISWAP_TRADING_API_URL`
 * is unset the factory returns `undefined`, {@link quoteAnyToken} returns `null`, and the
 * agent pay path behaves EXACTLY as today (direct USDC). The quote is purely additive — a
 * failed or dormant quote can never block or alter the settlement (doctrine law #5).
 *
 * FAIL-FAST vs FAIL-SOFT: {@link quoteAnyToken} validates its args at entry and throws a
 * typed {@link AnyTokenQuoteError} on malformed input or a bad Trading-API response (the
 * strict library contract). The route wiring wraps the call so ANY such error resolves to
 * "no quote", never a blocked settlement — strict primitive, defensive integration.
 *
 * Server-only (doctrine guardrail #4 / #7): the Trading-API key lives behind the injected
 * fetch and must never reach the browser bundle.
 */

import { isAddress, type Address } from 'viem'

import { assertServerOnly } from './serverOnly.js'
import { buildPayoutSwapDeps } from '../payout-swap/deps-from-env.js'
import type { FetchLike } from '../payout-swap/rails/uniswapTradingApi.js'

assertServerOnly('anyTokenQuote')

/** Hard deadline for the pre-settlement quote fetch, so a hung upstream never stalls a payment. */
const QUOTE_TIMEOUT_MS = 5_000

/** Why an any-token quote could not be produced (all are caught fail-soft by the route). */
export type AnyTokenQuoteFailure =
  | 'invalid-args' // a required arg was missing/malformed — a caller bug, surfaced fail-fast.
  | 'quote-http-error' // the Trading API returned a non-2xx status.
  | 'quote-malformed-response' // the Trading API body lacked the `amountIn` we depend on.

/**
 * Typed error thrown by {@link quoteAnyToken}. Carries a machine-readable {@link reason} and a
 * human message that NEVER contains a secret (guardrail #7). The route maps every instance to
 * "no quote" so settlement is never blocked.
 */
export class AnyTokenQuoteError extends Error {
  /** The category of failure, for programmatic handling. */
  readonly reason: AnyTokenQuoteFailure
  constructor(reason: AnyTokenQuoteFailure, message: string) {
    super(message)
    this.name = 'AnyTokenQuoteError'
    this.reason = reason
  }
}

/** The transport an any-token quote needs: the Trading-API base URL + a keyed fetch. */
export interface AnyTokenQuoteDeps {
  /** Trading API base URL (from `UNISWAP_TRADING_API_URL`, via the payout-swap env seam). */
  readonly baseUrl: string
  /** Fetch with the `x-api-key` header pre-injected (or plain fetch when no key is set). */
  readonly fetchImpl: FetchLike
}

/**
 * A request for an any-token payment quote.
 *
 * `tokenOut` is the settlement token (USDC) the payment is denominated in; `tokenIn` is the
 * token X the agent is asking the cost in. Supply the target as EITHER `usdAmount` (a
 * convenience that assumes `tokenOut` is 6-decimal USDC) OR an explicit `tokenOutAmount` in
 * `tokenOut` base units — exactly one, never both.
 */
export interface AnyTokenQuoteRequest {
  /** The chain the payment settles on (a same-chain quote, not a bridge). */
  readonly chainId: number
  /** The input token the agent wants the cost quoted in (e.g. WETH). Must be a 0x address. */
  readonly tokenIn: string
  /** The settlement token the payment is denominated in (USDC). Must be a 0x address. */
  readonly tokenOut: string
  /** Target settlement value in USD (assumes `tokenOut` is 6-decimal USDC). Mutually exclusive with `tokenOutAmount`. */
  readonly usdAmount?: number
  /** Target settlement amount in `tokenOut` base units. Mutually exclusive with `usdAmount`. */
  readonly tokenOutAmount?: bigint
  /** Optional payer/swapper address for a routed quote. When given, must be a 0x address. */
  readonly swapper?: string
}

/**
 * A resolved any-token quote. `amountIn` is the headline: how much `tokenIn` the payment
 * costs. All amounts are atomic (the token's own decimals) — never floats.
 */
export interface AnyTokenQuote {
  /** The input token quoted (what the agent would pay in). */
  readonly tokenIn: Address
  /** The settlement token the payment is denominated in (USDC). */
  readonly tokenOut: Address
  /** How much `tokenIn` the payment costs, atomic in `tokenIn` decimals. */
  readonly amountIn: bigint
  /** The settlement amount the quote targets, atomic in `tokenOut` decimals. */
  readonly amountOut: bigint
  /** A short, human-readable route summary for logs/telemetry (never a secret). */
  readonly routeSummary: string
  /** Unix-seconds expiry after which the quote must be refreshed (`0` when the API omits it). */
  readonly expiresAtSec: number
  /** Opaque routing id echoed by the Trading API (for a follow-on order, if ever wired). */
  readonly quoteId?: string
}

/**
 * A JSON-safe projection of {@link AnyTokenQuote} (bigints rendered as decimal strings) so the
 * quote can be placed directly in a `JSON.stringify`'d HTTP response body.
 */
export interface AnyTokenQuoteJson {
  readonly tokenIn: string
  readonly tokenOut: string
  readonly amountIn: string
  readonly amountOut: string
  readonly routeSummary: string
  readonly expiresAtSec: number
  readonly quoteId?: string
}

/** The subset of the Trading API `/quote` response this module depends on (booth-confirm). */
interface TradingApiQuoteResponse {
  /** Input amount required to hit the requested output, atomic in `tokenIn` decimals, as a string. */
  amountIn?: string
  /** Echoed output amount, atomic in `tokenOut` decimals, as a string (optional; we already know it). */
  amountOut?: string
  /** Opaque routing id. */
  quoteId?: string
  /** Optional human route label (e.g. "UniswapX", "V3"). */
  routing?: string
  /** Optional quote expiry, unix seconds. */
  deadline?: number
}

/**
 * Build the any-token quote transport from the shared payout-swap env seam. Returns
 * `undefined` (dormant) when `UNISWAP_TRADING_API_URL` is unset — the single dormancy switch.
 * Never throws: a missing var just leaves the seam off.
 *
 * @returns The {@link AnyTokenQuoteDeps}, or `undefined` when the Trading-API env is absent.
 */
export function buildAnyTokenQuoteDeps(): AnyTokenQuoteDeps | undefined {
  const tradingApi = buildPayoutSwapDeps().uniswapTradingApi
  if (!tradingApi) return undefined
  return { baseUrl: tradingApi.baseUrl, fetchImpl: tradingApi.fetchImpl }
}

/**
 * Resolve the target settlement amount (in `tokenOut` base units) from a validated request.
 * `usdAmount` assumes 6-decimal USDC; `tokenOutAmount` is used verbatim.
 */
function resolveAmountOut(req: AnyTokenQuoteRequest): bigint {
  if (req.tokenOutAmount !== undefined) return req.tokenOutAmount
  // usdAmount path: USD → 6-decimal USDC base units (1e6 per USD), rounded like the settlement meter.
  return BigInt(Math.round((req.usdAmount as number) * 1_000_000))
}

/**
 * Fail-fast guard clauses for {@link quoteAnyToken}. Throws {@link AnyTokenQuoteError}
 * (`invalid-args`) on any malformed field — no silent coercion (code laws).
 */
function assertValidRequest(req: AnyTokenQuoteRequest): void {
  if (!isAddress(req.tokenIn)) {
    throw new AnyTokenQuoteError('invalid-args', 'tokenIn must be a valid 0x address')
  }
  if (!isAddress(req.tokenOut)) {
    throw new AnyTokenQuoteError('invalid-args', 'tokenOut must be a valid 0x address')
  }
  if (!Number.isInteger(req.chainId) || req.chainId <= 0) {
    throw new AnyTokenQuoteError('invalid-args', 'chainId must be a positive integer')
  }
  if (req.swapper !== undefined && !isAddress(req.swapper)) {
    throw new AnyTokenQuoteError('invalid-args', 'swapper must be a valid 0x address when provided')
  }
  const hasUsd = req.usdAmount !== undefined
  const hasOut = req.tokenOutAmount !== undefined
  if (hasUsd === hasOut) {
    throw new AnyTokenQuoteError('invalid-args', 'provide exactly one of usdAmount or tokenOutAmount')
  }
  if (hasUsd && (!Number.isFinite(req.usdAmount) || (req.usdAmount as number) <= 0)) {
    throw new AnyTokenQuoteError('invalid-args', 'usdAmount must be a positive, finite number')
  }
  if (hasOut && (req.tokenOutAmount as bigint) <= 0n) {
    throw new AnyTokenQuoteError('invalid-args', 'tokenOutAmount must be a positive integer amount')
  }
}

/** Compose a short, non-secret route summary for logs/telemetry. */
function summarizeRoute(body: TradingApiQuoteResponse, req: AnyTokenQuoteRequest, amountOut: bigint): string {
  const via = typeof body.routing === 'string' && body.routing.length > 0 ? body.routing : 'trading-api'
  return `${body.amountIn} ${req.tokenIn} -> ${amountOut.toString()} ${req.tokenOut} via ${via}`
}

/**
 * Quote how much `tokenIn` a USDC-settled payment costs, via the Uniswap Trading API.
 *
 * DORMANT when the transport env is absent: returns `null` (the agent path is unchanged).
 * STRICT otherwise: validates args fail-fast and throws {@link AnyTokenQuoteError} on
 * malformed input, a non-2xx status, or a response missing `amountIn`. The caller (the
 * route) is responsible for fail-soft handling so a quote never blocks settlement.
 *
 * @param req  The quote request (tokenIn + tokenOut + chainId + a single amount target).
 * @param deps Injected transport; defaults to {@link buildAnyTokenQuoteDeps} (env-sourced).
 *   Pass a mock in tests. `undefined` (env absent) → the dormant `null`.
 * @returns The mapped {@link AnyTokenQuote}, or `null` when the seam is dormant.
 * @throws {AnyTokenQuoteError} on malformed args (`invalid-args`), a bad status
 *   (`quote-http-error`), or a response missing `amountIn` (`quote-malformed-response`).
 */
export async function quoteAnyToken(
  req: AnyTokenQuoteRequest,
  deps: AnyTokenQuoteDeps | undefined = buildAnyTokenQuoteDeps(),
): Promise<AnyTokenQuote | null> {
  // Fail-fast: validate args at entry, before touching the network or the dormancy switch,
  // so a caller bug surfaces the same way whether or not the seam is live.
  assertValidRequest(req)

  // Dormant: no transport env → the seam is off, the agent path is exactly as today.
  if (!deps) return null

  const amountOut = resolveAmountOut(req)

  // Bound the fetch: this quote is awaited BEFORE settlement, so an unbounded hang here would
  // stall a real payment. A hard 5s deadline degrades to a thrown AbortError, which the caller
  // (maybeAnyTokenQuote) already swallows to a fail-soft `null` — the payment proceeds unquoted.
  const res = await deps.fetchImpl(`${deps.baseUrl}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    body: JSON.stringify({
      // EXACT_OUTPUT: fix the settlement (tokenOut) amount, let the API return the tokenIn cost.
      type: 'EXACT_OUTPUT',
      chainId: req.chainId,
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amount: amountOut.toString(),
      swapper: req.swapper,
    }),
  })
  if (!res.ok) {
    throw new AnyTokenQuoteError('quote-http-error', `Trading API /quote failed (${res.status})`)
  }

  const body = (await res.json()) as TradingApiQuoteResponse
  if (!body.amountIn) {
    throw new AnyTokenQuoteError('quote-malformed-response', 'Trading API /quote returned no amountIn')
  }

  return {
    tokenIn: req.tokenIn as Address,
    tokenOut: req.tokenOut as Address,
    amountIn: BigInt(body.amountIn),
    amountOut,
    routeSummary: summarizeRoute(body, req, amountOut),
    expiresAtSec: typeof body.deadline === 'number' && Number.isFinite(body.deadline) ? body.deadline : 0,
    quoteId: body.quoteId,
  }
}

/**
 * Project an {@link AnyTokenQuote} to a JSON-safe DTO (bigints → decimal strings) for an HTTP
 * response body. `JSON.stringify` cannot serialize bigints, so the route uses this before
 * attaching a quote to its response.
 *
 * @param quote The resolved quote.
 * @returns The {@link AnyTokenQuoteJson} projection.
 */
export function toAnyTokenQuoteJson(quote: AnyTokenQuote): AnyTokenQuoteJson {
  return {
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountIn: quote.amountIn.toString(),
    amountOut: quote.amountOut.toString(),
    routeSummary: quote.routeSummary,
    expiresAtSec: quote.expiresAtSec,
    quoteId: quote.quoteId,
  }
}
