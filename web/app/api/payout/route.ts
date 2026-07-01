/**
 * POST /api/payout — the private payout leg endpoint.
 *
 * Flow (spec §4): verify caller identity -> validate body -> ensureRegistered(userId)
 * -> shieldAndWithdraw -> return { depositTx, withdrawTx }. This is a post-settlement
 * async action, entirely OFF the Solidity CEI money path (spec §9.4) — it never calls
 * the router.
 *
 * AUTH (money-path IDOR guard): `userId` is the Dynamic JWT `sub` and is derived
 * from the SERVER-VERIFIED token (via `resolveVerifiedUserId`), NEVER trusted from
 * the request body. A body-supplied `userId` that disagrees with the verified `sub`
 * is rejected — an attacker cannot drive another identity's withdrawal path.
 *
 * The merchant's Unlink account is derived from a server key pair (`account.fromKeys`)
 * for the transfer/withdraw legs; the seed-backed (browser) derivation is a separate
 * path and never runs here (zero custody — spec §9.1). For the demo the account is
 * supplied by the caller wiring; this route owns validation, registration ordering,
 * and law-#5 error surfacing.
 *
 * SECRETS: no Unlink API key is ever placed in a response body or error message.
 *
 * Standard Web `Request`/`Response` so it works as a Next.js App Router handler
 * (`export async function POST`) and typechecks without the Next types installed.
 */
import { isAddress } from "viem";
import {
  resolveVerifiedUserId,
  TenantAuthError,
} from "../../../lib/branding/tenant.js";
import { ensureRegistered, getMerchantClient } from "../../../lib/unlink/payoutService.js";
import {
  shieldAndWithdraw,
  ShieldFailedError,
  WithdrawFailedError,
  type WithdrawResult,
} from "../../../lib/unlink/privateWithdraw.js";
import { usdToUsdcBaseUnits } from "../../../lib/unlink/amount.js";
import { loadUnlinkSdk, UnlinkSdkUnavailableError } from "../../../lib/unlink/loadSdk.js";

/** Force Node runtime — the payout service uses server-only secrets. */
export const runtime = "nodejs";

interface PayoutBody {
  /** USD amount to withdraw to the fresh EOA (smaller leg). */
  amountUsd: number;
  /** USD amount to shield into the private set (larger leg — must exceed amountUsd). */
  depositAmountUsd: number;
  /** Fresh payer EOA — never the funding wallet. */
  destination: `0x${string}`;
  /** Dynamic JWT `sub`, reused as the Unlink userId. */
  userId: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Dependency seam so tests can inject a client without standing up the real SDK.
 * In production this is wired by the caller (`feat/checkout-web`) to a `fromKeys`
 * server account + `getMerchantClient`. Exported for the route's own test only.
 */
export interface PayoutDeps {
  /**
   * Resolve the caller's identity (`userId` = Dynamic JWT `sub`) from the
   * SERVER-VERIFIED token, cross-checking any body `userId`. Injected so tests can
   * exercise the auth outcomes without standing up the real JWKS.
   */
  resolveVerifiedUserId: (
    req: Request,
    body: unknown,
  ) => Promise<{ userId: string; verified: boolean }>;
  ensureRegistered: typeof ensureRegistered;
  shieldAndWithdraw: (params: {
    depositAmountUsdc: number;
    withdrawAmountUsdc: number;
    destination: `0x${string}`;
  }) => Promise<WithdrawResult>;
}

/**
 * Core handler, dependency-injected. Validates input, registers the user BEFORE
 * shielding, runs the asymmetric shield+withdraw, and maps failures to the spec's
 * status codes. No secret ever reaches the response.
 */
export async function handlePayout(req: Request, deps: PayoutDeps): Promise<Response> {
  let body: Partial<PayoutBody>;
  try {
    body = (await req.json()) as Partial<PayoutBody>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { amountUsd, depositAmountUsd, destination } = body;

  // ── Auth (money-path IDOR guard): derive userId from the VERIFIED JWT ─────────
  // The `sub` comes from the server-verified Dynamic token — a body-supplied
  // `userId` is only allowed to CONFIRM it (must match), never to assert it.
  let userId: string;
  let verified: boolean;
  try {
    ({ userId, verified } = await deps.resolveVerifiedUserId(req, body));
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return json({ error: err.message }, 401);
    }
    return json({ error: "unauthorized" }, 401);
  }
  // Money-path FAIL-CLOSED: a withdraw MUST originate from a cryptographically
  // verified caller. The resolver's booth-gated fallback (Dynamic env unset)
  // returns `verified:false` after only shape-checking the body — acceptable for
  // read paths, but NEVER for a payout. Reject rather than trust a body-derived id.
  if (!verified) {
    return json({ error: "unverified_caller" }, 401);
  }

  // ── Validation (spec §4 error table) ─────────────────────────────────────────
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    return json({ error: "amountUsd must be a positive number" }, 400);
  }
  if (
    typeof depositAmountUsd !== "number" ||
    !Number.isFinite(depositAmountUsd) ||
    depositAmountUsd <= 0
  ) {
    return json({ error: "depositAmountUsd must be a positive number" }, 400);
  }
  // Hygiene: the shield MUST be larger than the withdraw (asymmetry keystone).
  if (depositAmountUsd <= amountUsd) {
    return json({ error: "depositAmountUsd must be greater than amountUsd" }, 400);
  }
  if (typeof destination !== "string" || !isAddress(destination)) {
    return json({ error: "destination must be a valid 0x address" }, 400);
  }

  // ── Register BEFORE shielding (call-order asserted by tests) ──────────────────
  try {
    await deps.ensureRegistered(userId);
  } catch (err) {
    // Fail-soft: the proprietary SDK isn't installed in this build (pre-booth).
    // No funds moved — surface a clean, recoverable config error, never a 500.
    if (err instanceof UnlinkSdkUnavailableError) {
      return json({ code: "unlink_sdk_unavailable", recoverable: true }, 503);
    }
    // Registration failure is unexpected (already-registered is swallowed upstream).
    return json({ error: "registration_failed" }, 500);
  }

  // ── Shield + withdraw, mapping the law-#5 recoverable case explicitly ────────
  try {
    const result = await deps.shieldAndWithdraw({
      depositAmountUsdc: usdToUsdcBaseUnits(depositAmountUsd),
      withdrawAmountUsdc: usdToUsdcBaseUnits(amountUsd),
      destination,
    });
    return json({ depositTx: result.depositTx, withdrawTx: result.withdrawTx }, 200);
  } catch (err) {
    if (err instanceof ShieldFailedError) {
      // No funds shielded — safe to retry.
      return json({ code: "shield_failed" }, 502);
    }
    if (err instanceof WithdrawFailedError) {
      // Shield landed; funds are in the private balance, recoverable (law #5).
      return json({ code: "withdraw_failed", recoverable: true }, 502);
    }
    if (err instanceof UnlinkSdkUnavailableError) {
      // SDK absent (pre-booth): nothing shielded, recoverable — never a 500.
      return json({ code: "unlink_sdk_unavailable", recoverable: true }, 503);
    }
    return json({ error: "unexpected_error" }, 500);
  }
}

/**
 * Next.js App Router entry. Wires the real dependencies. The merchant Unlink
 * account + client must be supplied by the caller's server wiring in production;
 * here we surface a clear 500 until that seam is connected at the booth, so the
 * route never silently no-ops.
 */
export async function POST(req: Request): Promise<Response> {
  const deps: PayoutDeps = {
    resolveVerifiedUserId,
    ensureRegistered,
    shieldAndWithdraw: (args) => buildServerPayout(args),
  };
  return handlePayout(req, deps);
}

/**
 * Production wiring for the shield+withdraw leg. Builds the server-side Unlink
 * client from a `fromKeys` account (zero custody: no `execute` capability), then
 * runs the real `shieldAndWithdraw`. The `account.fromKeys` derivation + the userId
 * the client is bound to are supplied by the booth wiring (env-keyed server key);
 * until that env is present we fail LOUD rather than silently no-op.
 *
 * ⚠️ BOOTH-WIRE: set the server payout key env + the bound userId here.
 */
async function buildServerPayout(args: {
  depositAmountUsdc: number;
  withdrawAmountUsdc: number;
  destination: `0x${string}`;
}): Promise<WithdrawResult> {
  const serverKey = process.env.UNLINK_PAYOUT_PRIVATE_KEY as `0x${string}` | undefined;
  const payoutUserId = process.env.UNLINK_PAYOUT_USER_ID;
  if (!serverKey || !payoutUserId) {
    throw new Error(
      "payout client not wired (booth: set UNLINK_PAYOUT_PRIVATE_KEY + UNLINK_PAYOUT_USER_ID, build fromKeys account)",
    );
  }
  // The server account is key-backed (transfer/withdraw only, no execute) — built
  // by the booth wiring from `account.fromKeys({ privateKey: serverKey })`. The
  // SDK is loaded optionally (loadUnlinkSdk) so a missing package fails soft.
  const { account: unlinkAccountFactory } = await loadUnlinkSdk();
  const serverAccount = await unlinkAccountFactory.fromKeys({ privateKey: serverKey });
  const client = await getMerchantClient(serverAccount, payoutUserId);
  return shieldAndWithdraw({ client, ...args });
}
