/**
 * Private-payout action surface (WILL-TRY).
 *
 * Guides the merchant through an Unlink private withdrawal from inside MetaMask,
 * WITHOUT opening the dapp. This handler is entirely off-CEI: it calls the
 * hosted checkout web API (which calls the Unlink SDK off-chain) and never
 * touches the router contract. The Snap holds NO keys and NO funds.
 *
 * Doctrine:
 *  - #1 zero custody: the destination EOA is derived deterministically from
 *    MetaMask's own BIP-44 entropy; the seed never leaves the wallet.
 *  - #4 truth in copy: callers surface the verbatim DEMO.md privacy line, never
 *    "anonymous" / "untraceable".
 *  - #5 never swallow a failure: a failed withdraw returns `recoverable: true`
 *    so the user knows their USDC is safe in the Unlink private balance.
 *  - No private key or API token ever appears in a returned error.
 */

import { SnapError } from '@metamask/snaps-sdk';

import { explorerTxBase } from '../router/chains';
import type { PayoutResult } from '../types';

/** Error code: the requested amount exceeds the merchant's payout budget. */
export const ERR_BUDGET_EXCEEDED = -32001;
/** Error code: the Unlink shield (deposit) step failed. */
export const ERR_SHIELD_FAILED = -32002;
/** Error code: the Unlink withdraw step failed (funds remain re-derivable). */
export const ERR_WITHDRAW_FAILED = -32003;

/**
 * The shape of `POST /api/payout`'s success body (matches `feat/unlink-private`).
 */
type ApiPayoutResponse = {
  ok: boolean;
  error?: string;
  depositTx?: `0x${string}`;
  withdrawTx?: `0x${string}`;
};

/**
 * Derives a fresh destination EOA address. Injected so the unit is testable
 * without the MetaMask sandbox; in production it wraps `snap_getBip44Entropy`.
 */
export type AddressDeriver = (
  /** BIP-44 address index (the daily index). */
  index: number,
) => Promise<`0x${string}`>;

/** A `fetch`-like function, injected for testability. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * The day index used for the fresh daily EOA — days since the Unix epoch in UTC.
 * A new index every UTC day means the destination address is never reused.
 *
 * @param now - Current time in ms (defaults to `Date.now()`); injectable for tests.
 * @returns The integer day index.
 */
export function dailyAddressIndex(now: number = Date.now()): number {
  return Math.floor(now / 86_400_000);
}

/**
 * Parameters for {@link initiatePrivatePayout}.
 */
export type InitiatePrivatePayoutParams = {
  /** The merchant's user id (opaque; the API maps it to the payout account). */
  userId: string;
  /** The amount to withdraw, in USD. */
  amountUsd: number;
  /** The shield deposit amount, in USD. */
  depositAmountUsd: number;
};

/**
 * Dependencies for {@link initiatePrivatePayout}, injected for testability.
 */
export type PrivatePayoutDeps = {
  /** Base URL of the hosted checkout API (allowlisted in the manifest). */
  apiBaseUrl: string;
  /** Numeric chain id used to build the Arcscan links. */
  chainId: number;
  /** Derives the fresh daily destination EOA. */
  deriveAddress: AddressDeriver;
  /** `fetch` implementation. */
  fetchImpl: FetchLike;
  /** Optional clock override for the daily index. */
  now?: number;
};

/**
 * Initiate a private payout via the checkout API.
 *
 * Flow: derive a fresh daily EOA → `POST /api/payout` → return both tx hashes
 * with explorer links. Failures map to the spec's error codes; a failed
 * withdraw carries `recoverable: true` so the user knows funds are safe.
 *
 * @param params - The payout request.
 * @param deps - Injected dependencies (API base, deriver, fetch, clock).
 * @returns A {@link PayoutResult} with both tx hashes and explorer links.
 * @throws {SnapError} `-32001` budget_exceeded, `-32002` shield_failed,
 *   `-32003` withdraw_failed (with `data.recoverable === true`).
 * @warn Never includes a private key or API token in any thrown error.
 */
export async function initiatePrivatePayout(
  params: InitiatePrivatePayoutParams,
  deps: PrivatePayoutDeps,
): Promise<PayoutResult> {
  const { userId, amountUsd, depositAmountUsd } = params;

  if (amountUsd <= 0 || amountUsd > depositAmountUsd) {
    throw new SnapError({
      code: ERR_BUDGET_EXCEEDED,
      message: 'budget_exceeded',
    });
  }

  const index = dailyAddressIndex(deps.now);
  const destination = await deriveAddressSafely(deps.deriveAddress, index);

  let body: ApiPayoutResponse;
  try {
    const res = await deps.fetchImpl(`${deps.apiBaseUrl}/api/payout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountUsd, depositAmountUsd, destination, userId }),
    });
    body = (await res.json()) as ApiPayoutResponse;
    if (!res.ok || !body.ok) {
      // Distinguish shield vs withdraw using the API's error tag.
      if (body.error === 'shield_failed' || !body.depositTx) {
        throw new SnapError({
          code: ERR_SHIELD_FAILED,
          message: 'shield_failed',
        });
      }
      throw new SnapError(
        { code: ERR_WITHDRAW_FAILED, message: 'withdraw_failed' },
        { recoverable: true },
      );
    }
  } catch (error) {
    if (error instanceof SnapError) {
      throw error;
    }
    // A network/parse error before any deposit ⇒ shield never landed.
    throw new SnapError({ code: ERR_SHIELD_FAILED, message: 'shield_failed' });
  }

  if (!body.depositTx) {
    throw new SnapError({ code: ERR_SHIELD_FAILED, message: 'shield_failed' });
  }
  if (!body.withdrawTx) {
    throw new SnapError(
      { code: ERR_WITHDRAW_FAILED, message: 'withdraw_failed' },
      { recoverable: true },
    );
  }

  const base = explorerTxBase(deps.chainId);
  return {
    depositTx: body.depositTx,
    withdrawTx: body.withdrawTx,
    arcscanDepositUrl: `${base}${body.depositTx}`,
    arcscanWithdrawUrl: `${base}${body.withdrawTx}`,
  };
}

/**
 * Derive the destination address, converting any deriver failure into a
 * `shield_failed` error WITHOUT leaking the underlying key material or message.
 *
 * @param deriveAddress - The injected deriver.
 * @param index - The daily address index.
 * @returns The derived address.
 * @throws {SnapError} `-32002` if derivation fails.
 */
async function deriveAddressSafely(
  deriveAddress: AddressDeriver,
  index: number,
): Promise<`0x${string}`> {
  try {
    return await deriveAddress(index);
  } catch {
    // Never surface the entropy error verbatim — it could echo key material.
    throw new SnapError({ code: ERR_SHIELD_FAILED, message: 'shield_failed' });
  }
}
