/**
 * @file privateRail.ts — the PRIVATE alternate rail wiring for POST /api/agent/pay.
 *
 * Keeps the route a thin entry: this file owns (a) deciding whether the private rail is
 * configured, (b) building the server-side Unlink payout client from a key-backed
 * account, and (c) mapping `payMerchantPrivately`'s outcomes/errors to the route's
 * decision. The default path (public x402) is untouched — when this returns a fallback
 * signal the route uses the public path exactly as before.
 *
 * SECRETS: `UNLINK_PRIVATE_PAY_KEY` / `UNLINK_API_KEY` are read server-side only and
 * NEVER placed in a response or error (secrets law). The SDK is loaded optionally
 * (`loadUnlinkSdk`) so a missing package fails soft to the public path, never a build
 * break or a 500.
 *
 * ⚠️ BOOTH-WIRE: set `UNLINK_PRIVATE_PAY_KEY` (the agent's server payout key) + confirm
 * `account.fromKeys` arg shape against the live SDK before the smoke test.
 */

import { isAddress } from "viem";
import { ensureRegistered, getMerchantClient } from "../../../../lib/unlink/payoutService.js";
import { shieldAndWithdraw } from "../../../../lib/unlink/privateWithdraw.js";
import { loadUnlinkSdk, UnlinkSdkUnavailableError } from "../../../../lib/unlink/loadSdk.js";
import {
  payMerchantPrivately,
  ShieldFailedError,
  WithdrawFailedError,
  type PrivatePayDeps,
} from "../../../../lib/unlink/privatePay.js";
import { isPrivatePayFlagOn } from "../../../../lib/unlink/privatePayConfig.js";

/** Force Node runtime — the private rail uses server-only secrets. */
export const runtime = "nodejs";

/** The request shape the route hands the private rail. */
export interface PrivateRailRequest {
  /** Merchant payee address (required when the private rail runs). */
  merchant?: string;
  /** USD amount the merchant is paid (the smaller, asymmetric leg). */
  amountUsd: number;
}

/**
 * The rail's decision for the route:
 *  - `handled: true`        → the private payment landed; return depositTx/paymentTx.
 *  - `fallback: true`       → rail off / unconfigured / SDK absent; use the public path.
 *  - `badRequest: string`   → the rail was requested but the input is invalid (e.g. no
 *                             merchant address) — a 400, NOT a silent fallback, so the
 *                             caller learns their private request was malformed.
 */
export type PrivateRailResult =
  | { handled: true; depositTx: string; paymentTx: string }
  | { handled: false; fallback: true }
  | { handled: false; badRequest: string };

/**
 * Thrown when the shield landed but the payout leg failed — funds are parked in the
 * private balance, recoverable (law #5). Mapped by the route to a 502 with a clean code.
 */
export class PrivatePayFailed extends Error {
  readonly code: "shield_failed" | "withdraw_failed";
  readonly recoverable: boolean;
  constructor(code: "shield_failed" | "withdraw_failed", recoverable: boolean) {
    super(`PrivatePayFailed: ${code}`);
    this.name = "PrivatePayFailed";
    this.code = code;
    this.recoverable = recoverable;
  }
}

/**
 * Production wiring for the agent's private payout account. Builds a key-backed Unlink
 * client (`account.fromKeys` → transfer/withdraw only, no `execute` — zero custody)
 * bound to the agent payout userId. Until the booth env is present we fail LOUD inside
 * `payMerchantPrivately`'s `getClient` (recoverable), never a silent no-op.
 */
function buildAgentPayoutDeps(): PrivatePayDeps {
  return {
    ensureRegistered,
    getClient: async () => {
      const serverKey = process.env.UNLINK_PRIVATE_PAY_KEY as `0x${string}` | undefined;
      const payoutUserId = process.env.UNLINK_PAYOUT_USER_ID;
      if (!serverKey || !payoutUserId) {
        throw new Error(
          "private rail not wired (booth: set UNLINK_PRIVATE_PAY_KEY + UNLINK_PAYOUT_USER_ID)",
        );
      }
      const { account: unlinkAccountFactory } = await loadUnlinkSdk();
      const serverAccount = await unlinkAccountFactory.fromKeys({ privateKey: serverKey });
      const client = await getMerchantClient(serverAccount, payoutUserId);
      return { client, account: serverAccount };
    },
    shieldAndWithdraw,
  };
}

/** The bound userId the private rail registers + pays from (the agent's Unlink identity). */
function railUserId(): string {
  return (process.env.UNLINK_PAYOUT_USER_ID ?? "").trim();
}

/**
 * Attempt the private rail. NEVER throws for an off/unconfigured rail — returns a
 * fallback signal so the route uses the unchanged public path. Throws only the law-#5
 * recoverable {@link PrivatePayFailed} (shield landed, payout failed).
 *
 * @param req   The merchant + amount for the private payment.
 * @param deps  Injected for tests; defaults to the real server payout wiring.
 * @returns A {@link PrivateRailResult} telling the route what to do.
 */
export async function attemptPrivateRail(
  req: PrivateRailRequest,
  deps: PrivatePayDeps = buildAgentPayoutDeps(),
): Promise<PrivateRailResult> {
  // Cheap gate first: if the flag is off, fall back without touching any wiring.
  if (!isPrivatePayFlagOn()) {
    return { handled: false, fallback: true };
  }
  // The rail was explicitly requested — a missing/invalid merchant is a 400, not a
  // silent fallback (the caller asked for private and must give a payee).
  if (typeof req.merchant !== "string" || !isAddress(req.merchant)) {
    return { handled: false, badRequest: "merchant must be a valid 0x address for the private rail" };
  }
  const userId = railUserId();
  if (!userId) {
    // Flag on but no bound userId: rail is not configured → fall back to public path.
    return { handled: false, fallback: true };
  }

  const outcome = await payMerchantPrivately(
    { userId, merchant: req.merchant as `0x${string}`, amountUsd: req.amountUsd },
    deps,
  ).catch((err: unknown) => {
    if (err instanceof ShieldFailedError) {
      throw new PrivatePayFailed("shield_failed", err.recoverable);
    }
    if (err instanceof WithdrawFailedError) {
      throw new PrivatePayFailed("withdraw_failed", err.recoverable);
    }
    if (err instanceof UnlinkSdkUnavailableError) {
      // SDK absent — treat as a clean fallback to the public path.
      return { status: "unlink_sdk_unavailable", recoverable: true } as const;
    }
    throw err;
  });

  if (outcome.status === "paid") {
    return { handled: true, depositTx: outcome.depositTx, paymentTx: outcome.paymentTx };
  }
  // "not_configured" or "unlink_sdk_unavailable" → fall back to the public x402 path.
  return { handled: false, fallback: true };
}
