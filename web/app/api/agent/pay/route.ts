/**
 * @file route.ts — POST /api/agent/pay (Next.js 15 App Router).
 *
 * The HTTP entry point for the autonomous agent. It validates the request, enforces an
 * env-configured URL allowlist (SSRF guard) and a call cap, then delegates to the
 * meter-gated x402 pay path. All errors map to structured JSON with NO secret or stack trace
 * in the body (doctrine guardrail #7 / law #4):
 *
 *   200  { ok: true, result }            single call
 *   200  { ok: true, results: [...] }    nano-loop
 *   200  { ok: true, rail: "private", depositTx, paymentTx }   private rail (UNLINK_PRIVATE_PAY=true)
 *   400  { error: "BadRequest", ... }    bad body / url not allowlisted / count too high
 *   402  { error: "BudgetExceeded", spent, cap }
 *   502  { error: "PaymentRequiredUnresolved" }
 *   502  { error: "PrivatePayFailed", code, recoverable }      shield landed but payout failed (law #5)
 *   500  { error: "Internal" }           any other throw — no leak
 *
 * CALLER AUTH (R-5): spending is gated by an internal shared secret BEFORE any money moves.
 * The route signs and spends real USDC, so the per-call cap + SSRF allowlist + human gate are
 * defense-in-depth, NOT the security boundary. The boundary is the `x-internal-secret` header
 * matched against `AGENT_INTERNAL_SECRET` (constant-time). It FAILS CLOSED: when the secret is
 * unset the route refuses with 503 `not_configured`, UNLESS the explicit local-dev escape hatch
 * `AGENT_ALLOW_INSECURE=true` is set (never set in production). 401 on a missing/wrong header.
 *
 * THE PRIVATE RAIL (this unit): by default a spend is a PUBLIC x402/EIP-3009 USDC
 * transfer (the path above, unchanged). When the body carries `private: true` AND the
 * env flag `UNLINK_PRIVATE_PAY=true` is set with the Unlink config present, the request
 * instead takes an alternate rail that shields the agent funds and pays the merchant
 * from a fresh EOA (edge-unlinkability, NOT a mixer — law #4). With the flag off, the
 * rail unconfigured, or the SDK absent, the route FALLS BACK to the unchanged public
 * path and NEVER drops the payment.
 */

import { timingSafeEqual } from "node:crypto";
import { agentPay, agentNanoLoop, PaymentRequiredUnresolved } from "../../../../lib/agent/payPerCall.js";
import { agentAddress } from "../../../../lib/agent/dynamicAgentWallet.js";
import { BudgetExceeded } from "../../../../lib/agent/agentMeter.js";
import { assertAgentTrialAllowed, HumanGateRequired } from "../../../../lib/worldid/agentGate.js";
import {
  attemptPrivateRail,
  PrivatePayFailed,
  type PrivateRailRequest,
} from "./privateRail.js";

/** Hard ceiling on a single nano-loop request — law #4: the agent fires real, bounded calls. */
const MAX_DEMO_CALLS = 50;

/** Default per-call price when the body omits one (matches the $0.001 micro-call). */
const DEFAULT_PRICE_USD = 0.001;

/** Minimal JSON response shim so this file type-checks without importing `next/server`. */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Constant-time string equality for the internal-secret check, so a wrong header can't be
 * recovered byte-by-byte via response timing. A length mismatch returns false immediately.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Caller-authentication gate (R-5) — the real security boundary for a route that signs and
 * spends real USDC. Runs BEFORE any payment effect (CEI). Returns a refusal {@link Response}
 * when the caller is not authorized, or `null` to proceed.
 *
 *   - `AGENT_INTERNAL_SECRET` set  → require an exact `x-internal-secret` match → else 401.
 *   - `AGENT_INTERNAL_SECRET` unset → FAIL CLOSED with 503 `not_configured`, UNLESS the explicit
 *     local-dev escape hatch `AGENT_ALLOW_INSECURE=true` is set (never set in production).
 *
 * @param req The incoming request (for the `x-internal-secret` header).
 * @returns A refusal Response when blocked, or `null` when the caller is authorized.
 */
function callerAuthFailure(req: Request): Response | null {
  const secret = (process.env.AGENT_INTERNAL_SECRET ?? "").trim();
  if (secret) {
    const provided = req.headers.get("x-internal-secret") ?? "";
    if (!timingSafeEqualStr(provided, secret)) {
      return json({ error: "Unauthorized" }, 401);
    }
    return null;
  }
  if ((process.env.AGENT_ALLOW_INSECURE ?? "").trim().toLowerCase() === "true") {
    return null;
  }
  return json({ error: "Agent pay is not configured on this deployment.", code: "not_configured" }, 503);
}

/**
 * Parse the allowlist of permitted origins from the server env (SSRF guard — guardrail #7).
 * The allowlist is env-configured, never hardcoded, so each deployment controls exactly which
 * x402 endpoints the agent may pay.
 *
 * @returns The set of allowed origins (`scheme://host[:port]`); empty when unset (deny-all).
 */
function allowedOrigins(): Set<string> {
  const raw = process.env.AGENT_URL_ALLOWLIST ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Whether `url` is well-formed and its origin is in the allowlist.
 *
 * @param url The candidate endpoint url from the request body.
 * @returns `true` if the url parses and its origin is allowlisted.
 */
function isAllowed(url: string): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return allowedOrigins().has(origin);
}

/** The accepted request body shape for POST /api/agent/pay. */
interface PayRequest {
  url: string;
  count?: number;
  pricePerCallUsd?: number;
  /** Opt into the private rail (shield + pay merchant from a fresh EOA). Default false. */
  private?: boolean;
  /** Merchant payee address for the private rail (required only when `private` is true). */
  merchant?: string;
}

/**
 * Validate and narrow an untrusted JSON value into a {@link PayRequest}.
 *
 * @param body The parsed (untrusted) request body.
 * @returns The validated request, or a string describing the first validation failure.
 */
function validate(body: unknown): PayRequest | string {
  if (typeof body !== "object" || body === null) {
    return "body must be a JSON object";
  }
  const b = body as Record<string, unknown>;
  if (typeof b.url !== "string" || b.url.length === 0) {
    return "url is required";
  }
  if (b.count !== undefined && (!Number.isInteger(b.count) || (b.count as number) < 1)) {
    return "count must be a positive integer";
  }
  if (typeof b.count === "number" && b.count > MAX_DEMO_CALLS) {
    return `count must not exceed ${MAX_DEMO_CALLS}`;
  }
  if (
    b.pricePerCallUsd !== undefined &&
    (typeof b.pricePerCallUsd !== "number" || !Number.isFinite(b.pricePerCallUsd) || (b.pricePerCallUsd as number) <= 0)
  ) {
    return "pricePerCallUsd must be a positive number";
  }
  if (b.private !== undefined && typeof b.private !== "boolean") {
    return "private must be a boolean";
  }
  if (b.merchant !== undefined && (typeof b.merchant !== "string" || b.merchant.length === 0)) {
    return "merchant must be a non-empty string";
  }
  return {
    url: b.url,
    count: b.count as number | undefined,
    pricePerCallUsd: b.pricePerCallUsd as number | undefined,
    private: b.private as boolean | undefined,
    merchant: b.merchant as string | undefined,
  };
}

/**
 * Handle POST /api/agent/pay. See the file header for the full status map.
 *
 * @param req The incoming request; body is `{ url, count?, pricePerCallUsd? }`.
 * @returns A JSON {@link Response} with the structured success or error body.
 */
export async function POST(req: Request): Promise<Response> {
  // R-5: authenticate the caller BEFORE any work or money effect. A 401/503 here means the
  // request never reaches validation, the meter, or the wallet — the cap/allowlist below are
  // defense-in-depth, not the gate.
  const authFailure = callerAuthFailure(req);
  if (authFailure) return authFailure;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return json({ error: "BadRequest", reason: "invalid JSON body" }, 400);
  }

  const validated = validate(parsed);
  if (typeof validated === "string") {
    return json({ error: "BadRequest", reason: validated }, 400);
  }
  if (!isAllowed(validated.url)) {
    return json({ error: "BadRequest", reason: "url not in allowlist" }, 400);
  }

  // Track A (World ID ADR D6 / unit 7): when AGENT_REQUIRE_HUMAN is on, only an
  // agent backed by a verified human gets the trial allowance. Checked BEFORE
  // any network effect (CEI), like the meter. Off by default → no-op, existing
  // behavior preserved. It never touches money — the meter still owns the budget.
  try {
    assertAgentTrialAllowed();
  } catch (err) {
    if (err instanceof HumanGateRequired) {
      return json({ error: "HumanGateRequired" }, 402);
    }
    return json({ error: "Internal" }, 500);
  }

  // Private rail (alternate, opt-in): only when the body asks for it. When the flag is
  // off, the rail is unconfigured, or the SDK is absent, this returns null and we fall
  // through to the unchanged public x402 path below — the payment is never dropped.
  if (validated.private === true) {
    try {
      const price = validated.pricePerCallUsd ?? DEFAULT_PRICE_USD;
      const railReq: PrivateRailRequest = { merchant: validated.merchant, amountUsd: price };
      const railResult = await attemptPrivateRail(railReq);
      if (railResult.handled) {
        return json(
          { ok: true, rail: "private", depositTx: railResult.depositTx, paymentTx: railResult.paymentTx, agent: await agentAddress() },
          200,
        );
      }
      if ("badRequest" in railResult) {
        return json({ error: "BadRequest", reason: railResult.badRequest }, 400);
      }
      // railResult.fallback === true → drop through to the public path unchanged.
    } catch (err) {
      if (err instanceof PrivatePayFailed) {
        // Shield landed but the payout leg failed — funds parked, recoverable (law #5).
        return json({ error: "PrivatePayFailed", code: err.code, recoverable: err.recoverable }, 502);
      }
      // Any other throw on the private rail: no secret, no stack (guardrail #7).
      return json({ error: "Internal" }, 500);
    }
  }

  try {
    const price = validated.pricePerCallUsd ?? DEFAULT_PRICE_USD;
    if (validated.count !== undefined && validated.count > 1) {
      const results = await agentNanoLoop({
        url: validated.url,
        count: validated.count,
        pricePerCallUsd: price,
      });
      return json({ ok: true, results, agent: await agentAddress() }, 200);
    }
    const result = await agentPay({ url: validated.url, maxValueUsd: price });
    return json({ ok: true, result, agent: await agentAddress() }, 200);
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return json({ error: "BudgetExceeded", spent: err.spent, cap: err.cap }, 402);
    }
    if (err instanceof PaymentRequiredUnresolved) {
      return json({ error: "PaymentRequiredUnresolved" }, 502);
    }
    // Any other throw: no secret, no stack trace in the body (guardrail #7).
    return json({ error: "Internal" }, 500);
  }
}
