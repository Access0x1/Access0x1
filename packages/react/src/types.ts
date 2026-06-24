/**
 * @file Shared types for the Access0x1 React SDK.
 *
 * These mirror the on-chain shapes of {@link https://github.com/Access0x1/Access0x1 | Access0x1Router}
 * — the zero-custody, multi-tenant payments router. Every value that crosses the chain boundary is a
 * `bigint` (token / USD amounts) or a 0x-prefixed hex string (addresses, hashes, tx hashes), never a
 * lossy JavaScript `number`.
 *
 * This module is the SDK's **public type surface**: the on-chain shapes (below), the `<PayButton>`
 * callback payloads ({@link QuoteResult}, {@link SettledResult}), the graceful-degrade
 * {@link PayButtonDisabledReason} union, and a re-export of the typed error union
 * ({@link Access0x1ErrorCode}). Importing from here keeps `<PayButton>`'s props, its callbacks, and
 * its error branching all anchored to one tree-shakeable, fully-typed source.
 */

// Re-exported so the error union is part of the SDK's public *type* surface alongside the payloads
// it appears in (e.g. {@link QuoteResult.error}). The runtime `Access0x1Error` class + the
// `toAccess0x1Error` normalizer continue to live in `./errors.js`; this is a type-only re-export
// (zero runtime cost under `verbatimModuleSyntax`, fully tree-shakeable).
export type { Access0x1ErrorCode } from './errors.js';

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

// ---------------------------------------------------------------------------
// `<PayButton>` public surface — callback payloads + the graceful-degrade union
//
// These are kept here (not inline in the component) so the component's props, its
// callback signatures, and the host app's own handlers can all import one canonical,
// fully-typed shape. They are type-only declarations: zero runtime, fully tree-shakeable.
// ---------------------------------------------------------------------------

/**
 * The reason a {@link PaymentReceipt}-bearing flow cannot start, surfaced to `<PayButton>` so it can
 * render a *disabled* button with truthful, specific copy instead of letting the buyer click into a
 * guaranteed on-chain revert.
 *
 * - `no-client`        — no viem/wagmi client was supplied, so nothing can be read or signed.
 * - `no-feed`          — the host declared (via `priceFeedConfigured={false}`) that no Chainlink
 *                        feed backs this token on this router; `quote()` would revert.
 * - `token-not-allowed`— the chosen pay-in `token` is absent from the host-supplied `allowedTokens`
 *                        allowlist; `payToken`/`quote` would revert with `TOKEN_NOT_ALLOWED`.
 * - `quote-unavailable`— a live probe `quote()` failed in a way that means this token/feed pair is
 *                        not payable right now (stale/invalid feed, or router-side token-not-allowed).
 */
export type PayButtonDisabledReason =
  | 'no-client'
  | 'no-feed'
  | 'token-not-allowed'
  | 'quote-unavailable';

/**
 * The payload handed to `<PayButton>`'s `onQuote` callback once `router.quote()` resolves (or fails).
 *
 * Fires on every quote attempt so the host app can render a live "you'll pay ~X TOKEN" line, drive
 * analytics, or detect an unpriceable token before the buyer ever signs. Exactly one of
 * {@link grossAmount} / {@link error} is non-null.
 */
export interface QuoteResult {
  /** The merchant the quote was priced for. */
  merchantId: bigint;
  /** The pay-in token quoted; {@link NATIVE_TOKEN} for a native payment. */
  token: Hex;
  /** The USD price the quote was requested at, 8-decimal (e.g. `$29.00` = `2_900_000_000n`). */
  usdAmount8: bigint;
  /** The quoted gross token amount from `router.quote()`, in the token's own decimals; `null` on failure. */
  grossAmount: bigint | null;
  /** The typed error if the quote itself reverted (feed stale/invalid, token not allowed); else `null`. */
  error: import('./errors.js').Access0x1Error | null;
}

/**
 * The payload handed to `<PayButton>`'s `onSettled` callback after a payment lands on-chain.
 *
 * A thin wrapper over the decoded {@link PaymentReceipt} that adds the explorer-ready
 * {@link explorerUrl} (when the host supplied an `explorerBaseUrl`), so a host can render a
 * "view receipt" link without re-deriving it. `onSettled` is the receipt-centric sibling of the
 * existing `onSuccess` callback; both fire on the same settlement.
 */
export interface SettledResult {
  /** The decoded on-chain receipt for the settled payment. */
  receipt: PaymentReceipt;
  /** A ready-to-open block-explorer URL for {@link PaymentReceipt.txHash}, or `null` if no base URL was given. */
  explorerUrl: string | null;
}
