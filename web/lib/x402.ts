/**
 * The x402 / Circle Nanopayments seller spine.
 *
 * Builds HTTP-402 payment requirements and wraps a route handler so it runs IFF
 * Circle settles the payer's EIP-3009 authorization. This is the gas-free
 * micro-payment HOT PATH — the handoff to `Access0x1Router.payToken` (Chainlink
 * pricing + fee split + Unlink private withdraw) lives on the WITHDRAW leg, in a
 * separate unit, NOT here.
 *
 * Doctrine:
 *  - law #4 (truth in copy): never return HTTP 200 unless settle succeeded; a
 *    `$0` / non-numeric price is rejected (no free paid endpoints).
 *  - law #5 (money paths never swallow): verify-fail and settle-fail surface as
 *    402 (retryable); a malformed payload surfaces as 500 (never a silent 200).
 *  - off-CEI: strict verify → settle → handler ordering; the handler never runs
 *    before settle returns success.
 *  - no Paymaster, no hand-rolled batch: `BatchFacilitatorClient` accumulates the
 *    authorizations and submits one on-chain batch tx.
 */
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";

import {
  ARC_TESTNET_FACILITATOR_URL,
  ARC_TESTNET_GATEWAY_WALLET,
  ARC_TESTNET_NETWORK,
  ARC_TESTNET_USDC,
} from "./arc-constants.js";
import { recordPayment } from "./payment-ledger.js";

/** The signed EIP-3009 + x402 payload the payer sends (verify/settle input). */
export type SignedPayload = {
  x402Version: number;
  payload: Record<string, unknown>;
  [key: string]: unknown;
};

/** Payment requirements broadcast in the HTTP-402 challenge. */
export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  asset: string;
  /** 6-decimal atomic USDC string, e.g. "1000" for $0.001. */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: "GatewayWalletBatched";
    version: "1";
    verifyingContract: string;
  };
};

/** A bare Web Fetch route handler (Next.js App Router style). */
export type Handler = (req: Request) => Promise<Response>;

/** EIP-3009 authorization validity window (4 days), per Circle's SDK default. */
const MAX_TIMEOUT_SECONDS = 345600;

/**
 * The seller payout wallet — a plain EOA (doctrine guardrail #1: zero custody;
 * the Gateway Balance belongs to this address, never to this server).
 *
 * Read lazily so module import never throws in test/build environments that have
 * not set it; the FIRST call into `withGateway` / `buildPaymentRequirements`
 * resolves and validates it.
 */
function resolveSellerAddress(): string {
  const seller = process.env.SELLER_ADDRESS;
  if (!seller || seller.trim() === "") {
    throw new Error(
      "SELLER_ADDRESS is not set — the merchant payout wallet (a plain EOA) is required to build payment requirements.",
    );
  }
  return seller;
}

/**
 * Convert a price string like "$0.001" into 6-decimal atomic USDC.
 *
 * Uses `Math.round(price * 1_000_000)` for float-safety (e.g. $0.07 → 70000, not
 * 69999). Rejects non-positive / non-numeric prices — there are no free paid
 * endpoints (law #4).
 *
 * @param price - dollar price, with or without a leading "$", e.g. "$0.03"
 * @returns the atomic USDC amount as a decimal string, e.g. "30000"
 * @throws if the price is not a finite number greater than zero
 */
function priceToAtomicUsdc(price: string): string {
  const cleaned = price.trim().replace(/^\$/, "");
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) {
    throw new Error(`Invalid price "${price}": not a number.`);
  }
  if (dollars <= 0) {
    throw new Error(
      `Invalid price "${price}": must be greater than zero (no free paid endpoints — law #4).`,
    );
  }
  return String(Math.round(dollars * 1_000_000));
}

/**
 * Build the x402 payment requirements for a priced endpoint.
 *
 * @param price - dollar price string, e.g. "$0.001"
 * @returns the requirements broadcast in the 402 challenge; `amount` is atomic
 *          USDC and `extra.verifyingContract` is the Arc Gateway Wallet
 * @throws if SELLER_ADDRESS is unset, or the price is non-positive / non-numeric
 *
 * Invariant: `network === ARC_TESTNET_NETWORK`, `asset === ARC_TESTNET_USDC`,
 * and `extra.name === "GatewayWalletBatched"` — required for the payer to build
 * the correct EIP-712 signing domain against the Gateway Wallet.
 */
export function buildPaymentRequirements(price: string): PaymentRequirements {
  const amount = priceToAtomicUsdc(price);
  const payTo = resolveSellerAddress();
  return {
    scheme: "exact",
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount,
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };
}

/**
 * Module-level singleton facilitator. No Paymaster, no hand-rolled batch — the
 * `BatchFacilitatorClient` verifies the EIP-3009 signatures and submits one
 * on-chain batch tx (doctrine guardrail #7).
 */
const facilitator = new BatchFacilitatorClient({
  url: ARC_TESTNET_FACILITATOR_URL,
});

/** Convert atomic USDC (6-dec string) to a decimal string, e.g. "1000" → "0.001". */
function atomicToDecimalUsdc(atomic: string): string {
  const n = BigInt(atomic);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Base64-encode a JSON object for an x402 header. */
function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/** Base64-decode + JSON-parse an x402 header (throws on malformed input). */
function decodeHeader(value: string): SignedPayload {
  const json = Buffer.from(value, "base64").toString("utf8");
  return JSON.parse(json) as SignedPayload;
}

/** Build the 402 challenge response carrying base64 PAYMENT-REQUIRED. */
function challenge(requirements: PaymentRequirements): Response {
  return new Response(
    JSON.stringify({
      error: "Payment required",
      accepts: [requirements],
    }),
    {
      status: 402,
      headers: {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": encodeHeader(requirements),
      },
    },
  );
}

/**
 * Wrap a route handler with x402 / Circle Nanopayments gas-free settlement.
 *
 * Flow (strict off-CEI ordering):
 *   1. No `payment-signature` header        → 402 + base64 PAYMENT-REQUIRED.
 *   2. `facilitator.verify` returns invalid  → 402 { error, reason } (settle and
 *      handler NEVER run).
 *   3. `facilitator.settle` returns failure  → 402 { error, reason } (handler
 *      NEVER runs).
 *   4. settle succeeds                       → handler(req) runs, response gets a
 *      PAYMENT-RESPONSE header, and recordPayment fires best-effort.
 *   5. Malformed payload (bad base64 / JSON) → 500 { error, message } (never a
 *      silent 200).
 *
 * @param handler - the underlying route handler, run IFF settle succeeded
 * @param price - the dollar price string for this endpoint, e.g. "$0.001"
 * @param endpoint - the route path, for the ledger record, e.g. "/api/premium/quote"
 * @returns a wrapped `(req) => Promise<Response>` handler
 *
 * Invariant: the handler runs IFF settle succeeded — a failed settle that
 * returned 200 would be a false receipt (law #4), so it never happens.
 */
export function withGateway(
  handler: Handler,
  price: string,
  endpoint: string,
): Handler {
  // Build the payment requirements LAZILY on the first request — NOT at module
  // load. `next build` loads every route module to collect page data, so an
  // eager build here forced SELLER_ADDRESS to be set in the build env (it is a
  // runtime secret, not a build input). The fail-fast throw still fires on the
  // first real request if SELLER_ADDRESS is unset or the price is invalid;
  // memoized so it runs at most once per route.
  let memo: { requirements: ReturnType<typeof buildPaymentRequirements>; amountUsdc: string } | undefined;
  const ensureRequirements = () => {
    if (!memo) {
      const requirements = buildPaymentRequirements(price);
      memo = { requirements, amountUsdc: atomicToDecimalUsdc(requirements.amount) };
    }
    return memo;
  };

  return async function gatewayHandler(req: Request): Promise<Response> {
    const { requirements, amountUsdc } = ensureRequirements();
    const sigHeader = req.headers.get("payment-signature");
    if (!sigHeader) {
      return challenge(requirements);
    }

    let payload: SignedPayload;
    try {
      payload = decodeHeader(sigHeader);
    } catch (err) {
      // Malformed payload — surface explicitly, never a silent 200 (law #5).
      return new Response(
        JSON.stringify({
          error: "Payment processing error",
          message: err instanceof Error ? err.message : String(err),
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    try {
      // VERIFY first — settle and handler never run on an invalid auth.
      const verifyResult = await facilitator.verify(
        payload as never,
        requirements as never,
      );
      if (!verifyResult.isValid) {
        return new Response(
          JSON.stringify({
            error: "Payment verification failed",
            reason: verifyResult.invalidReason ?? "unknown",
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }

      // SETTLE second — handler never runs unless settle succeeds.
      const settleResult = await facilitator.settle(
        payload as never,
        requirements as never,
      );
      if (!settleResult.success) {
        return new Response(
          JSON.stringify({
            error: "Payment settlement failed",
            reason: settleResult.errorReason ?? "unknown",
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }

      // SERVE — settle succeeded, so the handler runs (law #4 satisfied).
      const response = await handler(req);

      // Record the settled payment best-effort (ledger errors are isolated).
      recordPayment({
        endpoint,
        payer: settleResult.payer ?? "unknown",
        amountUsdc,
        network: requirements.network,
        gatewayTx: settleResult.transaction ?? null,
        ts: Date.now(),
      });

      // Echo the settlement proof on the served response.
      const headers = new Headers(response.headers);
      headers.set(
        "PAYMENT-RESPONSE",
        encodeHeader({
          success: true,
          transaction: settleResult.transaction,
          network: settleResult.network,
          payer: settleResult.payer ?? "unknown",
        }),
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      // An unexpected facilitator error is surfaced, never swallowed (law #5).
      return new Response(
        JSON.stringify({
          error: "Payment processing error",
          message: err instanceof Error ? err.message : String(err),
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  };
}
