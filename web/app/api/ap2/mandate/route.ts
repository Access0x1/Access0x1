/**
 * @file route.ts — POST /api/ap2/mandate (Next.js 15 App Router).
 *
 * The AP2/A2A interop SURFACE. Given a merchantId + SessionGrant authorization (+ optional cart and
 * x402 rail params), DERIVES and returns the AP2 mandate chain (Intent ← Cart ← Payment) so an
 * AP2-aware counterparty — a non-EVM agent, a merchant payment gateway — can verify our agent acted
 * within a user-authorized, bounded, revocable mandate.
 *
 * This route is PURE DERIVATION. It moves NO money, holds NO custody, signs no transaction, and
 * touches no secret. It re-expresses an on-chain SessionGrant (the source of truth) in AP2 nouns. The
 * verification TRUTH stays on-chain — this is the wire format around it.
 *
 * CALLER CHECK + ON-CHAIN CAVEAT (O-10): the route DERIVES a mandate chain from a CALLER-SUPPLIED
 * SessionGrant view — which may be real or fabricated. It therefore (a) optionally gates the endpoint
 * behind a shared secret when `AP2_MANDATE_SECRET` is set (basic caller check; moves no money, so it
 * stays open when unset), and (b) returns a PROMINENT `onChainTruth` caveat so a consumer NEVER trusts
 * a derived mandate without re-verifying the SessionGrant on-chain itself.
 *
 *   200  { ok: true, mandates, onChainTruth }              full Intent (+ Cart + Payment if supplied)
 *   200  { ok: true, mandates, linksValid, onChainTruth }  when a full chain is built
 *   401  { error: "Unauthorized" }           AP2_MANDATE_SECRET set but the header is missing/wrong
 *   400  { error: "BadRequest", reason }      bad body / failed mandate-builder invariant (sum/budget)
 *   500  { error: "Internal" }                any other throw — no leak (doctrine guardrail #7)
 *
 * Doctrine:
 *  - law #4 (truth in copy): the returned mandates carry an UNSIGNED proof stub; we never dress an
 *    unsigned VC up as signed. The `note` + `onChainTruth` say the JWS is env-keyed at deploy and that
 *    the SessionGrant on-chain is the only authority.
 *  - law #5 (money paths never swallow): an over-budget cart or a cart-sum mismatch surfaces as a 400
 *    with the builder's reason, never a silent 200.
 */

import { timingSafeEqual } from "node:crypto";

import {
  type BuildOptions,
  type CartInput,
  type PaymentInput,
  type SessionGrantAuthorization,
  buildCartMandate,
  buildPaymentMandate,
  sessionGrantToIntentMandate,
  verifyChainLinks,
  type MandateChain,
} from "@/lib/ap2/mandate.js";

/**
 * A PROMINENT on-chain-truth caveat returned on every success (O-10). The mandate chain is DERIVED
 * from a caller-supplied SessionGrant view; the only authority is the on-chain SessionGrant, which a
 * consumer MUST re-verify itself before acting. This is not advisory copy — it is the contract.
 */
const ON_CHAIN_TRUTH =
  "DERIVED, NOT AUTHORITATIVE: this mandate chain is computed from the caller-supplied SessionGrant " +
  "view and may be real or fabricated. The ONLY source of truth is the on-chain SessionGrant — a " +
  "consumer MUST re-verify the grant (owner, delegate, budgetCap, spent, expiry, revoked) on-chain " +
  "before relying on any mandate here. The proof stub is UNSIGNED; the RFC-7515 JWS is env-keyed at deploy.";

/** Minimal JSON response shim so this file type-checks without importing `next/server`. */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Constant-time string equality for the optional caller check, so a wrong header can't be recovered
 * byte-by-byte via timing. A length mismatch short-circuits to false.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Basic caller check (O-10). When `AP2_MANDATE_SECRET` is set, require a matching `x-internal-secret`
 * header. The route moves NO money, so when the secret is UNSET the endpoint stays OPEN (the
 * on-chain caveat already prevents a consumer from trusting a derived mandate). Returns a refusal
 * {@link Response} when blocked, or `null` to proceed.
 */
function callerCheckFailure(req: Request): Response | null {
  const secret = (process.env.AP2_MANDATE_SECRET ?? "").trim();
  if (!secret) return null;
  const provided = req.headers.get("x-internal-secret") ?? "";
  return timingSafeEqualStr(provided, secret) ? null : json({ error: "Unauthorized" }, 401);
}

/** The accepted request body shape for POST /api/ap2/mandate. */
interface MandateRequest {
  /** The on-chain SessionGrant authorization to express as an Intent Mandate (required). */
  grant: SessionGrantAuthorization;
  /** Optional cart — when present, a Cart Mandate (and, if `payment` is present, a Payment Mandate). */
  cart?: CartInput;
  /** Optional x402 rail params — required to additionally build a Payment Mandate. */
  payment?: PaymentInput;
  /** Optional issuer/time overrides forwarded to the builders. */
  options?: BuildOptions;
}

function isHex(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);
}

function isDecString(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]+$/.test(v);
}

/**
 * Validate and narrow an untrusted JSON value into a {@link MandateRequest}. Validates only the shape
 * the route needs; the mandate builders enforce the value invariants (sum, budget, charge==cart).
 *
 * @param body - the parsed (untrusted) request body.
 * @returns the validated request, or a string describing the first validation failure.
 */
function validate(body: unknown): MandateRequest | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const b = body as Record<string, unknown>;

  const g = b.grant as Record<string, unknown> | undefined;
  if (typeof g !== "object" || g === null) return "grant is required";
  if (!isHex(g.sessionId)) return "grant.sessionId must be a 0x hex string";
  if (!isHex(g.owner)) return "grant.owner must be a 0x address";
  if (!isHex(g.delegate)) return "grant.delegate must be a 0x address";
  if (!isHex(g.token)) return "grant.token must be a 0x address";
  if (!isDecString(g.budgetCap)) return "grant.budgetCap must be a decimal string";
  if (g.spent !== undefined && !isDecString(g.spent)) return "grant.spent must be a decimal string";
  if (!Number.isInteger(g.expiry) || (g.expiry as number) < 0) return "grant.expiry must be a unix second";
  if (!Number.isInteger(g.nonce) || (g.nonce as number) < 0) return "grant.nonce must be a non-negative integer";
  if (!Number.isInteger(g.chainId) || (g.chainId as number) <= 0) return "grant.chainId must be a positive integer";
  if (g.revoked !== undefined && typeof g.revoked !== "boolean") return "grant.revoked must be a boolean";

  // cart / payment / options are optional; the builders validate their value invariants and throw a
  // clear message that the route maps to a 400.
  return {
    grant: g as unknown as SessionGrantAuthorization,
    cart: b.cart as CartInput | undefined,
    payment: b.payment as PaymentInput | undefined,
    options: b.options as BuildOptions | undefined,
  };
}

/**
 * Handle POST /api/ap2/mandate. See the file header for the status map. The handler NEVER moves money:
 * it derives the mandate chain from the supplied (caller-provided) SessionGrant view and returns it.
 *
 * @param req - the incoming request; body is {@link MandateRequest}.
 * @returns a JSON {@link Response} with the derived mandate(s) or a structured error.
 */
export async function POST(req: Request): Promise<Response> {
  // O-10: basic caller check (a no-op when AP2_MANDATE_SECRET is unset — the route moves no money).
  const authFailure = callerCheckFailure(req);
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

  const note =
    "Mandates carry an UNSIGNED proof stub. The enforcing mandate is on-chain (SessionGrant); this is " +
    "the AP2 interop view. A real RFC-7515 JWS is applied at deploy with the env-keyed domain key.";

  try {
    const intent = sessionGrantToIntentMandate(validated.grant, validated.options);

    // Intent only.
    if (!validated.cart) {
      return json({ ok: true, mandates: { intent }, note, onChainTruth: ON_CHAIN_TRUTH }, 200);
    }

    const cart = buildCartMandate(intent, validated.cart, validated.options);

    // Intent + Cart (no payment rail supplied).
    if (!validated.payment) {
      return json({ ok: true, mandates: { intent, cart }, note, onChainTruth: ON_CHAIN_TRUTH }, 200);
    }

    // Full chain: Intent ← Cart ← Payment.
    const payment = buildPaymentMandate(cart, validated.payment, validated.options);
    const chain: MandateChain = { intent, cart, payment };
    return json(
      { ok: true, mandates: chain, linksValid: verifyChainLinks(chain) === null, note, onChainTruth: ON_CHAIN_TRUTH },
      200,
    );
  } catch (err) {
    // A builder invariant failure (sum / budget / charge mismatch) is a client error, surfaced with
    // its reason (law #5: never a silent 200). The builder messages contain no secret.
    if (err instanceof Error && /(does not equal|exceeds)/.test(err.message)) {
      return json({ error: "BadRequest", reason: err.message }, 400);
    }
    return json({ error: "Internal" }, 500);
  }
}
