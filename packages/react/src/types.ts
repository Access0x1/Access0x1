/**
 * @file Shared types for the Access0x1 React SDK.
 *
 * These mirror the on-chain shapes of {@link https://github.com/Access0x1/Access0x1 | Access0x1Router}
 * — the zero-custody, multi-tenant payments router. Every value that crosses the chain boundary is a
 * `bigint` (token / USD amounts) or a 0x-prefixed hex string (addresses, hashes, tx hashes), never a
 * lossy JavaScript `number`.
 */

/** A 0x-prefixed, lowercase-or-checksummed Ethereum address or 32-byte hash. */
export type Hex = `0x${string}`;

/** The native-token sentinel: `address(0)` means the chain's native coin (e.g. ETH, or USDC on Arc). */
export const NATIVE_TOKEN: Hex = '0x0000000000000000000000000000000000000000';

/** The 32-byte zero value used for an absent `orderId`. */
export const ZERO_BYTES32: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * The lifecycle of a single payment, surfaced by {@link usePayment}.
 *
 * `idle → quoting → confirm → pending → success` is the happy path; any step may transition to
 * `error`. `confirm` is the window where the wallet is asking the user to approve the tx; `pending`
 * is after broadcast, waiting for inclusion.
 */
export type PaymentStatus =
  | 'idle'
  | 'quoting'
  | 'confirm'
  | 'pending'
  | 'success'
  | 'error';

/**
 * A decoded `PaymentReceived` event — the canonical on-chain receipt for a settled payment.
 *
 * Field names and decimals match the router event exactly. `srcChainSelector` is `0n` for a
 * same-chain payment (the only kind this SDK initiates).
 */
export interface PaymentReceipt {
  /** The merchant that was paid. */
  merchantId: bigint;
  /** The buyer (payer) address. */
  buyer: Hex;
  /** The pay-in token; {@link NATIVE_TOKEN} for a native payment. */
  token: Hex;
  /** Gross amount pulled from the buyer, in the token's own decimals. */
  grossAmount: bigint;
  /** Total fee leg (platform + merchant surcharge). */
  feeAmount: bigint;
  /** Net amount that landed at the merchant payout. */
  netAmount: bigint;
  /** The USD price the payment settled at, 8-decimal (e.g. `$29.00` = `2_900_000_000n`). */
  usdAmount8: bigint;
  /** The opaque order reference echoed from the request; {@link ZERO_BYTES32} if none was supplied. */
  orderId: Hex;
  /** CCIP-style source chain selector; `0n` for a same-chain payment. */
  srcChainSelector: bigint;
  /** The settlement transaction hash. */
  txHash: Hex;
  /** The block the payment settled in. */
  blockNumber: bigint;
}

/**
 * The on-chain `Merchant` record, as returned by the router's public `merchants(id)` getter.
 *
 * An unregistered id resolves to an all-zero struct; callers should treat `owner === address(0)` as
 * "not found" rather than a usable merchant.
 */
export interface MerchantInfo {
  /** The merchant id this record was read for. */
  id: bigint;
  /** Where the merchant's net payments land. */
  payout: Hex;
  /** The only address allowed to update this merchant. */
  owner: Hex;
  /** Where the merchant's fee leg lands; `address(0)` falls back to {@link payout} at pay time. */
  feeRecipient: Hex;
  /** The merchant's optional surcharge in basis points (50 = 0.50%). */
  feeBps: number;
  /** `false` means new payments to this merchant revert. */
  active: boolean;
  /** An identity commitment (no preimage stored on-chain). */
  nameHash: Hex;
}
