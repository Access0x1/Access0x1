/**
 * @file aiGateway.ts — `withAiGateway`: the "connect an AI API" composition. It is
 * a THIN wrapper that bolts API-key auth + a SessionGrant budget pre-check onto the
 * existing x402 seller spine (`lib/x402.ts`). It invents no new payment rail — the
 * money path is still the exact `withGateway` → Circle verify/settle flow.
 *
 * THE LAYERS (outer → inner), in CEI order so an unauthorized or over-budget call
 * settles NOTHING:
 *   1. API-KEY AUTH  — `lib/ai/apiKeys.ts` resolves the `Authorization: Bearer ak_…`
 *      key to a SessionGrant session id + the per-call price. No key ⇒ 401.
 *   2. BUDGET CHECK  — `lib/ai/sessionMeter.ts` reserves the per-call price against
 *      that session's off-chain budget mirror (the twin of `SessionGrant.remaining`/
 *      `spend`). Over budget / revoked / expired ⇒ 402 `SessionBudgetExceeded`.
 *   3. x402 SETTLE   — the inner `withGateway(handler, price, endpoint)` runs: it
 *      challenges with HTTP-402, then verifies + settles the payer's EIP-3009
 *      authorization via Circle, and runs `handler` IFF settle succeeded.
 *   4. REFUND ON MISS — if the inner gateway did NOT settle (it returned 402,
 *      meaning no payment moved), the budget reservation from step 2 is refunded
 *      (law #5). A settled-but-handler-failed call is NOT refunded — the money moved.
 *
 * THE HONEST BOUNDARY (law #4). The budget is enforced at this edge against the
 * off-chain mirror, NOT by submitting `SessionGrant.spend()` on-chain — this
 * version has no relayer/signer to do that, and we do not pretend otherwise. The
 * on-chain SessionGrant remains the authoritative ceiling; wiring a relayer to
 * also debit it on each settle is the documented next step (see
 * `lib/ai/sessionMeter.ts` and `docs/CONNECT-AI-API.md`). What IS real and on-chain
 * here is the x402 USDC settlement via Circle on Arc Testnet.
 *
 * Server-only: it reads the key registry + meter, never touches the browser.
 */

import { withGateway, type Handler } from "../x402.js";
import { resolveKey } from "./apiKeys.js";
import {
  reserveOrThrow,
  refundSession,
  SessionBudgetExceeded,
  SessionUnknown,
  type SessionId,
} from "./sessionMeter.js";

/** Header an AI client sends its Access0x1 key in: `Authorization: Bearer ak_…`. */
const AUTH_HEADER = "authorization";
const BEARER_PREFIX = "Bearer ";

/** Small JSON helper — never leaks internals (guardrail #7). */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Convert a `"$0.001"` price string to atomic USDC for the meter reservation. */
function priceToAtomic(price: string): bigint {
  const cleaned = price.trim().replace(/^\$/, "");
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    // Mirror x402.ts: no free paid endpoints (law #4). Surfaced as a config throw.
    throw new Error(`withAiGateway: invalid price "${price}"`);
  }
  return BigInt(Math.round(dollars * 1_000_000));
}

/** Extract a `Bearer ak_…` token from the request, or null. */
function bearerToken(req: Request): string | null {
  const raw = req.headers.get(AUTH_HEADER);
  if (!raw || !raw.startsWith(BEARER_PREFIX)) return null;
  const token = raw.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Wrap a handler so it is reachable only with a valid Access0x1 AI API key, is
 * metered against the key's SessionGrant budget, and is paid for via x402. See the
 * file header for the full layer/CEI order.
 *
 * The `price` is BOTH the SessionGrant reservation amount AND the x402 settle
 * amount, so the budget ceiling and the actual payment are the same number — a key
 * with a $1.00 session budget and a $0.001 per-call price affords exactly 1,000
 * calls before the budget rejects, independent of the daily agent meter.
 *
 * @param handler  The underlying AI handler, run IFF the key is valid, the budget
 *                 has room, AND Circle settles the payment.
 * @param price    The dollar price per call, e.g. "$0.001" — reserved against the
 *                 session AND charged via x402.
 * @param endpoint The route path for the payment ledger, e.g. "/api/ai/chat".
 * @returns A wrapped `(req) => Promise<Response>` handler.
 */
export function withAiGateway(handler: Handler, price: string, endpoint: string): Handler {
  // The inner x402 settlement layer — unchanged seller spine.
  const settledHandler = withGateway(handler, price, endpoint);

  return async function aiGatewayHandler(req: Request): Promise<Response> {
    // LAYER 1 — API-key auth (CEI: before any budget or money effect).
    const token = bearerToken(req);
    if (!token) {
      return json(
        {
          error: "Unauthorized",
          reason: "missing API key — send `Authorization: Bearer ak_…`",
        },
        401,
      );
    }
    const binding = resolveKey(token);
    if (!binding) {
      return json({ error: "Unauthorized", reason: "invalid API key" }, 401);
    }

    const sessionId: SessionId = binding.sessionId;

    // The per-call price is the key's bound price; it must agree with the x402
    // price so the reservation and the settlement are the same amount.
    const reserveAtomic = priceToAtomic(price);

    // LAYER 2 — SessionGrant budget check (the off-chain mirror; CEI check).
    try {
      reserveOrThrow(sessionId, reserveAtomic);
    } catch (err) {
      if (err instanceof SessionBudgetExceeded) {
        return json(
          {
            error: "SessionBudgetExceeded",
            sessionId,
            remaining: err.remaining.toString(),
            requested: err.requested.toString(),
          },
          402,
        );
      }
      if (err instanceof SessionUnknown) {
        // The key resolved but its session was never opened in this process —
        // a configuration gap, surfaced honestly rather than silently charging.
        return json({ error: "SessionUnknown", sessionId }, 402);
      }
      return json({ error: "Internal" }, 500);
    }

    // LAYER 3 — x402 settlement (the unchanged seller spine).
    let response: Response;
    try {
      response = await settledHandler(req);
    } catch (err) {
      // The inner gateway threw before settling — nothing moved, refund (law #5).
      refundSession(sessionId, reserveAtomic);
      throw err;
    }

    // LAYER 4 — refund the reservation IFF nothing settled. withGateway sets a
    // PAYMENT-RESPONSE header EXACTLY when settle succeeded (x402.ts step 4), so its
    // presence is the authoritative "money moved" signal. Keying off status===402
    // alone leaked budget: withGateway also returns HTTP 500 (not 402) for a
    // malformed payment-signature header or an unexpected facilitator error — no USDC
    // moved in either case, yet the old check kept the reservation, letting a client
    // burn its own SessionGrant budget with repeated garbled-signature calls. Refund
    // whenever settlement did not happen (law #5: never charge for a payment that
    // didn't move).
    if (!response.headers.has("PAYMENT-RESPONSE")) {
      refundSession(sessionId, reserveAtomic);
    }

    return response;
  };
}
