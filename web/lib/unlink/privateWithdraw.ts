/**
 * privateWithdraw — the private payout leg (shield then withdraw asymmetrically).
 *
 * THE UNLINKABILITY KEYSTONE (spec §2b — must stay honest, law #4):
 *  - shield MORE than you withdraw (asymmetric amounts)
 *  - withdraw to a FRESH EOA that has never been seen
 *  - deposit and withdraw are separate txs (timing separation)
 *  - optional in-shield `transfer` hop breaks the deposit -> spend trail
 *
 * What is hidden: the link between the funding wallet and the fresh payer EOA.
 * What is NOT hidden: that a deposit happened and that a withdrawal happened — both
 * endpoints are public on Arcscan; only the edge between them is broken. This is
 * statistical (anonymity-set) privacy on a thin testnet, NOT "anonymous" /
 * "untraceable" / "mixer" (law #4 — never claim those words).
 *
 * LAW #5 (money paths roll back, never swallow): `shieldAndWithdraw` is entirely
 * OFF the Solidity CEI money path. If the shield succeeds but the withdraw fails,
 * the funds remain in the merchant's private Unlink balance and are recoverable by
 * re-deriving the account. We surface that as a `recoverable` error and NEVER
 * swallow it — the caller must know funds are parked, not lost.
 *
 * ⚠️ BOOTH-CONFIRM the exact `depositWithApproval` / `withdraw` / `transfer` arg
 * shapes against docs.unlink.xyz before the live smoke test.
 */
import type { UnlinkClient } from "@unlink-xyz/sdk";
import { toUsdcBigInt } from "./amount.js";
import { ARC_TESTNET_ID } from "../chains.js";
import { UnlinkNotConfiguredError } from "./loadSdk.js";
import { unlinkChainId, unlinkUsdcToken } from "./privatePayConfig.js";

/**
 * The shielded USDC token for the active Unlink chain. Resolved PER CHAIN through
 * {@link unlinkUsdcToken} (`NEXT_PUBLIC_UNLINK_USDC_<chainId>`, defaulting to Arc's
 * `ARC_TESTNET_USDC`) at CALL time — never frozen at import, never an address from
 * memory (spec §9.7). Returns `""` when unset so the caller surfaces a clear config
 * error before any SDK call.
 */
function shieldedUsdcToken(): `0x${string}` {
  return unlinkUsdcToken() as `0x${string}`;
}

export interface WithdrawResult {
  /** The public shield tx hash (visible on Arcscan). */
  depositTx: string;
  /** The private withdrawal tx hash — the judge-visible privacy artifact. */
  withdrawTx: string;
}

/**
 * Error thrown when the shield succeeds but the withdraw fails. Carries
 * `recoverable: true` so the caller (and the API route) can tell the merchant the
 * funds are parked in their private balance, not lost (law #5).
 */
export class WithdrawFailedError extends Error {
  readonly recoverable = true as const;
  readonly code = "withdraw_failed" as const;
  /** The shield tx that DID land — funds are in the private balance behind it. */
  readonly depositTx: string;
  constructor(depositTx: string, cause?: unknown) {
    super("withdraw_failed: shield landed but withdraw failed; funds are in the private balance (re-derive to recover)");
    this.name = "WithdrawFailedError";
    this.depositTx = depositTx;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** Error thrown when the shield (deposit) itself fails — no funds left the wallet. */
export class ShieldFailedError extends Error {
  readonly recoverable = false as const;
  readonly code = "shield_failed" as const;
  constructor(cause?: unknown) {
    super("shield_failed: depositWithApproval failed; no funds shielded");
    this.name = "ShieldFailedError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Shield USDC into the private set, then withdraw a DIFFERENT, SMALLER amount to a
 * fresh destination EOA. The asymmetric amount + fresh EOA is the unlinkability
 * keystone (spec §2b).
 *
 * Call order (asserted by tests): asymmetry guard -> `depositWithApproval` ->
 * `waitForTx(depositTx)` -> `withdraw`. The withdraw never runs before the shield
 * has settled.
 *
 * @param params.client              A live Unlink client (from getMerchantClient).
 * @param params.depositAmountUsdc   Amount to shield, in 6-dec USDC base units (larger pool).
 * @param params.withdrawAmountUsdc  Amount to withdraw, in 6-dec USDC base units (smaller, asymmetric).
 * @param params.destination         Fresh payer EOA — never the funding wallet.
 */
export async function shieldAndWithdraw(params: {
  client: UnlinkClient;
  depositAmountUsdc: number;
  withdrawAmountUsdc: number;
  destination: `0x${string}`;
}): Promise<WithdrawResult> {
  const { client, depositAmountUsdc, withdrawAmountUsdc, destination } = params;

  // Asymmetry guard — must hold BEFORE any SDK call (hygiene + no zero/negative).
  if (withdrawAmountUsdc <= 0) {
    throw new Error("shieldAndWithdraw: withdrawAmountUsdc must be > 0");
  }
  if (depositAmountUsdc <= withdrawAmountUsdc) {
    throw new Error(
      "shieldAndWithdraw: depositAmountUsdc must be strictly greater than withdrawAmountUsdc (asymmetry keystone)",
    );
  }
  const usdc = shieldedUsdcToken();
  if (!usdc) {
    // DORMANT, NOT FAULTY (law #1). A blank token is an operator who has not
    // finished wiring the rail, and nothing has moved — the same non-event as a
    // missing api key. It used to throw a plain Error, which the payout route
    // could only map to 500 `unexpected_error`: an operator read that as "your
    // deployment is broken" when the truth was "one variable is still blank".
    // The typed error carries the variable NAME (never a value) and the route
    // answers 503 `not_configured, recoverable: true`.
    // Name BOTH accepted variables for the Arc default chain, since either one
    // wires it; off Arc only the per-chain name applies.
    const chainId = unlinkChainId();
    throw new UnlinkNotConfiguredError(
      ...(chainId === ARC_TESTNET_ID
        ? [`NEXT_PUBLIC_UNLINK_USDC_${chainId}`, "ARC_TESTNET_USDC"]
        : [`NEXT_PUBLIC_UNLINK_USDC_${chainId}`]),
    );
  }

  // 1. Shield (user pays Arc gas). If this fails, no funds left the wallet.
  let depositTx: string;
  try {
    const deposit = await client.depositWithApproval({
      token: usdc,
      amount: toUsdcBigInt(depositAmountUsdc),
    });
    depositTx = deposit.txHash;
  } catch (err) {
    throw new ShieldFailedError(err);
  }

  // 2. Wait for the shield to settle BEFORE withdrawing (timing separation + the
  //    private balance must exist before we spend from it).
  await client.waitForTx(depositTx as `0x${string}`);

  // 3. Withdraw a smaller amount to the fresh EOA (gasless — Unlink relays).
  //    If THIS fails, the shield already landed: funds are parked in the private
  //    balance, recoverable by re-derivation. Surface, never swallow (law #5).
  try {
    const withdraw = await client.withdraw({
      amount: toUsdcBigInt(withdrawAmountUsdc),
      destination,
    });
    return { depositTx, withdrawTx: withdraw.txHash };
  } catch (err) {
    throw new WithdrawFailedError(depositTx, err);
  }
}

/**
 * Optional private hop: one `transfer` inside the shielded set to an intermediate
 * `unlink1…` address. Hides sender/recipient/amount and breaks the deposit -> spend
 * trail before the final withdraw (spec §2b, item 4). Gasless (Unlink relays).
 *
 * @param params.toUnlinkAddress  MUST start with `"unlink1"` (in-shield bech32 form).
 * @returns                       The transfer tx hash.
 */
export async function privateTransfer(params: {
  client: UnlinkClient;
  amountUsdc: number;
  toUnlinkAddress: string;
}): Promise<string> {
  const { client, amountUsdc, toUnlinkAddress } = params;
  if (!toUnlinkAddress.startsWith("unlink1")) {
    throw new Error('privateTransfer: toUnlinkAddress must be an in-shield "unlink1…" address');
  }
  if (amountUsdc <= 0) {
    throw new Error("privateTransfer: amountUsdc must be > 0");
  }
  const result = await client.transfer({
    amount: toUsdcBigInt(amountUsdc),
    to: toUnlinkAddress,
  });
  return result.txHash;
}
