/**
 * privatePay — the PRIVATE agent-PAYMENT variant (shield the agent funds, then pay
 * the MERCHANT from a fresh EOA).
 *
 * Today an agent spend is a plain PUBLIC x402 / EIP-3009 USDC transfer: the agent's
 * funding wallet and the merchant are linked on-chain by that one transfer. This adds a
 * private rail. It REUSES the payout keystone (`shieldAndWithdraw`, `privateWithdraw.ts`):
 *
 *   1. shield MORE than you pay (asymmetric amounts) from the agent's private set,
 *   2. withdraw the SMALLER payment amount to the MERCHANT address (here the merchant IS
 *      the "fresh destination" — it has never been the agent's funding wallet),
 *   3. deposit and withdraw are separate, settled txs (timing separation).
 *
 * WHAT IS HIDDEN: the link between the agent's funding wallet and the merchant payment.
 * WHAT IS NOT: that a deposit happened and that a payment happened — both endpoints are
 * public on Arcscan; only the EDGE between them is broken. This is edge-unlinkability
 * (anonymity-set) privacy on a thin testnet, NOT a mixer and NOT "anonymous" /
 * "untraceable" (law #4 — never claim those words).
 *
 * LAW #5 (money paths roll back, never swallow): this leg is entirely OFF the Solidity
 * CEI money path. It reuses `shieldAndWithdraw`'s recoverable error types verbatim —
 * `ShieldFailedError` (no funds moved) and `WithdrawFailedError` (shield landed, funds
 * parked in the private balance, recoverable by re-derivation). They are re-exported
 * here so the route maps them exactly as the public payout route does.
 *
 * FAIL-SOFT (law #4): if the SDK is absent or the rail is off, this NEVER throws an
 * opaque error — `payMerchantPrivately` returns a structured `not_configured` /
 * `unlink_sdk_unavailable` result so the route can fall back to the unchanged public
 * x402 path. A payment is NEVER silently dropped: the caller always gets either a paid
 * result, a clear fallback signal, or a recoverable money-path error.
 *
 * ⚠️ BOOTH-CONFIRM the `account.fromKeys` / `depositWithApproval` / `withdraw` arg shapes
 * against docs.unlink.xyz before the live smoke test (same caveat as privateWithdraw.ts).
 */
import type { UnlinkAccount, UnlinkClient } from "@unlink-xyz/sdk";
import { usdToUsdcBaseUnits } from "./amount.js";
import {
  shieldAndWithdraw,
  ShieldFailedError,
  WithdrawFailedError,
  type WithdrawResult,
} from "./privateWithdraw.js";
import { UnlinkSdkUnavailableError } from "./loadSdk.js";
import { privatePayStatus, type PrivatePayStatus } from "./privatePayConfig.js";

export { ShieldFailedError, WithdrawFailedError, UnlinkSdkUnavailableError };

/**
 * Default shield multiple: shield this many times the payment amount so the deposit is
 * strictly larger than the withdraw (the asymmetry keystone). 4x keeps the on-chain
 * deposit obviously decoupled from the payment value without parking too much. Override
 * per call via `shieldMultiple` for the demo.
 */
export const DEFAULT_SHIELD_MULTIPLE = 4;

/** The outcome shape of a private merchant payment attempt (never throws for config). */
export type PrivatePayOutcome =
  | {
      /** The shield landed and the merchant was paid from the private set. */
      readonly status: "paid";
      /** The public shield tx hash (visible on Arcscan). */
      readonly depositTx: string;
      /** The private payment tx to the merchant — the judge-visible privacy artifact. */
      readonly paymentTx: string;
    }
  | {
      /**
       * The rail did not run because it is off / not configured. The caller MUST fall
       * back to the public x402 path — the payment was NOT attempted and NOT dropped.
       */
      readonly status: "not_configured";
      /** Why the rail is off (flag_off | not_configured), for an honest log line. */
      readonly reason: Exclude<PrivatePayStatus, "on">;
    }
  | {
      /**
       * The proprietary SDK is not installed in this build (pre-booth). No funds moved;
       * the caller falls back to the public path. Recoverable once the package is present.
       */
      readonly status: "unlink_sdk_unavailable";
      readonly recoverable: true;
    };

/**
 * The injectable shield+withdraw seam so the route's wiring and the tests can swap the
 * real `shieldAndWithdraw` for a mock without standing up the SDK. Mirrors the
 * `PayoutDeps` seam in `app/api/payout/route.ts`.
 */
export interface PrivatePayDeps {
  /** Idempotently register the agent's userId with Unlink before shielding. */
  ensureRegistered: (userId: string) => Promise<void>;
  /** Build a server-side Unlink client bound to the agent's payout account + userId. */
  getClient: () => Promise<{ client: UnlinkClient; account: UnlinkAccount } | UnlinkClient>;
  /** The real asymmetric shield+withdraw (or a mock). */
  shieldAndWithdraw: (params: {
    client: UnlinkClient;
    depositAmountUsdc: number;
    withdrawAmountUsdc: number;
    destination: `0x${string}`;
  }) => Promise<WithdrawResult>;
}

/**
 * Pay a merchant privately: shield a larger amount from the agent's private set, then
 * pay the merchant the requested amount from the fresh shielded balance. The merchant
 * address is the withdraw `destination` — the public on-chain endpoint that is NOT
 * linked to the agent's funding wallet.
 *
 * Call order (asserted by tests): config gate -> `ensureRegistered(userId)` ->
 * `getClient()` -> `shieldAndWithdraw`. Registration runs BEFORE any shield, exactly
 * like the public payout route.
 *
 * NEVER throws for an off/unconfigured rail or an absent SDK — those return a structured
 * outcome so the route falls back to the public x402 path. It DOES surface the law-#5
 * recoverable money-path errors (`ShieldFailedError` / `WithdrawFailedError`) by
 * re-throwing them, so funds parked in the private balance are never hidden.
 *
 * @param params.userId          The agent's Dynamic JWT `sub`, reused as the Unlink userId.
 * @param params.merchant        The merchant payee address (the withdraw destination).
 * @param params.amountUsd       USD the merchant is paid (the smaller, asymmetric leg).
 * @param params.shieldMultiple  Shield = amount * this multiple (default 4x). Must be > 1.
 * @param deps                   Injected ensureRegistered / getClient / shieldAndWithdraw.
 * @returns A {@link PrivatePayOutcome}; throws only on a law-#5 recoverable money error.
 */
export async function payMerchantPrivately(
  params: {
    userId: string;
    merchant: `0x${string}`;
    amountUsd: number;
    shieldMultiple?: number;
  },
  deps: PrivatePayDeps,
): Promise<PrivatePayOutcome> {
  const { userId, merchant, amountUsd } = params;
  const shieldMultiple = params.shieldMultiple ?? DEFAULT_SHIELD_MULTIPLE;

  // ── Config gate (fail-soft, never throws — law #4) ──────────────────────────
  const status = privatePayStatus();
  if (status !== "on") {
    return { status: "not_configured", reason: status };
  }

  // ── Input hygiene (a malformed amount must never silently pay zero — law #5) ─
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("payMerchantPrivately: amountUsd must be a positive number");
  }
  if (!(shieldMultiple > 1)) {
    throw new Error("payMerchantPrivately: shieldMultiple must be > 1 (asymmetry keystone)");
  }
  if (!userId) {
    throw new Error("payMerchantPrivately: userId is required");
  }

  const withdrawAmountUsdc = usdToUsdcBaseUnits(amountUsd);
  const depositAmountUsdc = usdToUsdcBaseUnits(amountUsd * shieldMultiple);

  // ── Register BEFORE shielding; absent SDK fails soft to the public path ──────
  try {
    await deps.ensureRegistered(userId);
  } catch (err) {
    if (err instanceof UnlinkSdkUnavailableError) {
      return { status: "unlink_sdk_unavailable", recoverable: true };
    }
    throw err;
  }

  // ── Shield + pay the merchant from the fresh private balance ─────────────────
  let client: UnlinkClient;
  try {
    const got = await deps.getClient();
    client = (got as { client?: UnlinkClient }).client ?? (got as UnlinkClient);
  } catch (err) {
    if (err instanceof UnlinkSdkUnavailableError) {
      return { status: "unlink_sdk_unavailable", recoverable: true };
    }
    throw err;
  }

  try {
    const result = await deps.shieldAndWithdraw({
      client,
      depositAmountUsdc,
      withdrawAmountUsdc,
      destination: merchant,
    });
    return { status: "paid", depositTx: result.depositTx, paymentTx: result.withdrawTx };
  } catch (err) {
    if (err instanceof UnlinkSdkUnavailableError) {
      // SDK vanished mid-flight (pre-booth): nothing shielded, recoverable — fall back.
      return { status: "unlink_sdk_unavailable", recoverable: true };
    }
    // ShieldFailedError / WithdrawFailedError surface unchanged (law #5 — never swallow).
    throw err;
  }
}

/** Re-export the default shield+withdraw so callers can wire the real one without a deep import. */
export { shieldAndWithdraw, type WithdrawResult, type PrivatePayStatus };
