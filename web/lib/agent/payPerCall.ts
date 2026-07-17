/**
 * @file payPerCall.ts — meter-gated x402 micro-payment fetch + autonomous nano-loop.
 *
 * Flow (design decision #3 — CEI at the meter level):
 *   1. {@link "./agentMeter".reserveDailySpend} reserves the budget — the CHECK. Over-cap
 *      throws `BudgetExceeded` with ZERO network calls. This is the DURABLE reserve: it
 *      enforces the daily cap ATOMICALLY across Cloud Run instances (a per-process ledger
 *      would let each instance spend the full cap), falling back to the in-memory ceiling
 *      when no DB is configured.
 *   2. `wrapFetchWithPayment(fetch, account)` from `x402-fetch` performs the paid call — the
 *      INTERACTION. It auto-intercepts HTTP 402, signs an EIP-3009 authorization off-chain via
 *      the {@link "./x402Signer".AgentX402Account}, and retries with the payment header.
 *   3. On a persistent 402 (payment never resolved) the budget is refunded (law #5). On an
 *      upstream non-402 error (e.g. 500) the fee was already consumed by the facilitator, so it
 *      is NOT refunded.
 *
 * The `x402-fetch` package is booth-confirm; its `wrapFetchWithPayment` surface is captured as
 * the injectable {@link WrapFetchWithPayment} seam so the unit type-checks and the CEI ordering
 * is unit-testable with a mock.
 *
 * Server-only (doctrine guardrail #4 / #7).
 */

import { assertServerOnly } from "./serverOnly.js";
import { reserveDailySpend, refundDailySpend } from "./agentMeter.js";
import { buildAgentX402Account, type AgentX402Account } from "./x402Signer.js";

assertServerOnly("payPerCall");

/** Thrown when the endpoint keeps returning 402 and the payment never resolves. */
export class PaymentRequiredUnresolved extends Error {
  constructor(url: string) {
    super(`PaymentRequiredUnresolved: ${url} still returned 402 after payment`);
    this.name = "PaymentRequiredUnresolved";
  }
}

/** Thrown when the endpoint returns a non-ok, non-402 status (the fee was already consumed). */
export class UpstreamError extends Error {
  /** The HTTP status the endpoint returned. */
  readonly status: number;
  constructor(url: string, status: number) {
    super(`UpstreamError: ${url} returned ${status}`);
    this.name = "UpstreamError";
    this.status = status;
  }
}

/** A fetch implementation (the global `fetch`, or x402's payment-wrapped wrapper). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The `x402-fetch` `wrapFetchWithPayment` surface: given a base fetch and a signing account,
 * return a fetch that transparently pays 402-gated endpoints.
 *
 * @warn BOOTH-CONFIRM: confirm the export name (`wrapFetchWithPayment`) and argument order
 *   against the installed `x402-fetch` major.
 */
export type WrapFetchWithPayment = (baseFetch: FetchLike, account: AgentX402Account) => FetchLike;

/** Default seam — throws until the real `x402-fetch` is injected at app boot (or by tests). */
let wrapFetchWithPayment: WrapFetchWithPayment = () => {
  throw new Error("x402-fetch not wired: call setWrapFetchWithPayment() at app boot");
};

/**
 * Inject the `x402-fetch` `wrapFetchWithPayment`. Called once at app boot with the real
 * package, and by tests with a mock.
 *
 * @param impl The wrapper, or `null` to restore the default throw.
 * @returns void
 */
export function setWrapFetchWithPayment(impl: WrapFetchWithPayment | null): void {
  wrapFetchWithPayment = impl ?? (() => {
    throw new Error("x402-fetch not wired: call setWrapFetchWithPayment() at app boot");
  });
}

/** The base fetch (injectable for tests; defaults to the global). */
let baseFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * Override the base fetch. Test-only; production uses the global `fetch`.
 *
 * @param impl The base fetch, or `null` to restore the global.
 * @returns void
 */
export function setBaseFetchForTests(impl: FetchLike | null): void {
  baseFetch = impl ?? ((url, init) => fetch(url, init));
}

/**
 * Pay for a single x402-protected call, gated by the never-negative daily budget meter.
 *
 * CEI: the meter is charged BEFORE any network call. A `BudgetExceeded` short-circuits with
 * zero fetches. If the wrapped fetch still returns 402 (payment unresolved) the charge is
 * refunded and {@link PaymentRequiredUnresolved} is thrown; a non-402 error surfaces as
 * {@link UpstreamError} without a refund (the facilitator already took the fee).
 *
 * @param args.url The x402-protected endpoint to call.
 * @param args.maxValueUsd The maximum USD this call may spend; reserved against the meter.
 * @param args.headers Optional extra request headers.
 * @returns The parsed JSON body of the successful (200) response.
 * @throws {BudgetExceeded} if the meter rejects the charge (no network call made).
 * @throws {PaymentRequiredUnresolved} if the endpoint keeps returning 402 (budget refunded).
 * @throws {UpstreamError} on a non-ok, non-402 response (budget NOT refunded).
 */
export async function agentPay(args: {
  url: string;
  maxValueUsd: number;
  headers?: Record<string, string>;
}): Promise<unknown> {
  const { url, maxValueUsd, headers } = args;

  // 1. CHECK — reserve budget first (DURABLE, cross-instance atomic). Throws
  //    BudgetExceeded with zero network effect.
  await reserveDailySpend(maxValueUsd);

  // 2. INTERACTION — pay-and-fetch via the x402 wrapper.
  const account = await buildAgentX402Account();
  const paidFetch = wrapFetchWithPayment(baseFetch, account);

  let res: Response;
  try {
    res = await paidFetch(url, headers ? { headers } : undefined);
  } catch (err) {
    // Network-level failure before any settlement: refund the reservation (law #5).
    await refundDailySpend(maxValueUsd);
    throw err;
  }

  if (res.status === 402) {
    // Payment never resolved — nothing settled, restore the budget (law #5).
    await refundDailySpend(maxValueUsd);
    throw new PaymentRequiredUnresolved(url);
  }
  if (!res.ok) {
    // The facilitator already consumed the fee; the call simply failed downstream. No refund.
    throw new UpstreamError(url, res.status);
  }
  return res.json();
}

/**
 * Fire `count` autonomous micro-calls in sequence, each paying `pricePerCallUsd`. Sequential
 * (not parallel) so the meter's spend check stays a correct running total and the demo shows a
 * deterministic batch on Arcscan. The per-call value is rounded to 6-decimal USDC math
 * (`Math.round(price * 1e6)`) — floating-point safe across the demo range (design decision #5).
 *
 * @param args.url The x402-protected endpoint to call repeatedly.
 * @param args.count Number of calls to fire (the route handler caps this for the demo).
 * @param args.pricePerCallUsd USD cost per call, reserved against the meter each iteration.
 * @returns An array of the `count` parsed JSON results, in call order.
 * @throws {BudgetExceeded} as soon as the running total would exceed the daily cap.
 */
export async function agentNanoLoop(args: {
  url: string;
  count: number;
  pricePerCallUsd: number;
}): Promise<unknown[]> {
  const { url, count, pricePerCallUsd } = args;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`agentNanoLoop: count must be a positive integer, got ${count}`);
  }
  const results: unknown[] = [];
  for (let i = 0; i < count; i++) {
    results.push(await agentPay({ url, maxValueUsd: pricePerCallUsd }));
  }
  return results;
}

/**
 * Convert a USD price to the integer 6-decimal USDC base-unit amount the EIP-3009
 * authorization carries. Exported for the route handler and verified by tests
 * (`usdToUsdcUnits(0.01) === 10000`).
 *
 * @param usd The USD price (e.g. `0.001`).
 * @returns The amount in USDC base units (1e6 per USD).
 */
export function usdToUsdcUnits(usd: number): number {
  return Math.round(usd * 1_000_000);
}
