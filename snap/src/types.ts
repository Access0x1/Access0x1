/**
 * Shared types for the Access0x1 MetaMask Snap.
 *
 * These describe the decoded payment intent (`PaymentSummary`), the resolved
 * merchant identity (`MerchantInfo`), and the result of a private payout
 * (`PayoutResult`). They are internal to the Snap bundle and are also the
 * shape returned across the `wallet_invokeSnap` boundary, so every field here
 * is JSON-serializable except the `bigint` fields, which the RPC handlers
 * stringify before returning to the dapp.
 */

/**
 * A decoded `payNative` / `payToken` call, ready to render in the insight panel.
 */
export interface PaymentSummary {
  /** The merchant the payment is destined for. */
  merchantId: bigint;
  /** Price in USD with 8 decimals (e.g. `2900000000n` === $29.00). */
  usdAmount8: bigint;
  /** ERC-20 token address, or `null` for a native-coin payment. */
  token: `0x${string}` | null;
  /**
   * Token amount in the token's own decimals. `0n` when the panel renders
   * before an on-chain quote is available (the price is read in-tx).
   */
  tokenAmount: bigint;
  /** The opaque order reference echoed in the receipt event. */
  orderId: `0x${string}`;
  /** UTF-8 decode of `orderId` if it is printable text, else the raw hex. */
  orderIdLabel: string;
  /** Numeric EVM chain id (e.g. 5042002 for Arc Testnet). */
  chainId: number;
  /** Human-readable chain name. */
  chainLabel: string;
}

/**
 * A merchant resolved from on-chain state plus an optional ENS label.
 */
export interface MerchantInfo {
  /** The merchant id. */
  id: bigint;
  /** ENS label if resolvable, otherwise `"Merchant #<id>"`. */
  name: string;
  /** Where the merchant's net payment lands. */
  payout: `0x${string}`;
  /** The merchant's surcharge in basis points (on top of the platform fee). */
  feeBps: number;
}

/**
 * The outcome of a private payout (the WILL-TRY surface). Carries the two
 * on-chain transactions (Unlink deposit + withdraw) plus pre-built explorer
 * links so the panel never has to build URLs itself.
 */
export interface PayoutResult {
  /** The Unlink shield (deposit) transaction hash. */
  depositTx: `0x${string}`;
  /** The Unlink withdraw transaction hash. */
  withdrawTx: `0x${string}`;
  /** Block-explorer URL for `depositTx`. */
  arcscanDepositUrl: string;
  /** Block-explorer URL for `withdrawTx`. */
  arcscanWithdrawUrl: string;
}

/**
 * Per-merchant white-label branding — DISPLAY-ONLY (doctrine #1).
 *
 * This is the readable identity a paying customer sees inside MetaMask at the
 * signing moment: the merchant's logo, "Pay {name}", and a one-line description.
 * It is pushed in by the hosted page/embed via the `setMerchantBranding` RPC,
 * fetched from the public `/api/branding` endpoint, or reconstructed from the
 * on-chain `nameHash`. It NEVER gates, signs, or blocks a money path or refund.
 *
 * All fields are sanitized before they are stored or rendered (see
 * `branding/sanitize.ts`). `logoSvg` is an INLINE SVG string only — `Image`
 * never accepts a URL (ADR D5).
 */
export interface MerchantBranding {
  /** The on-chain merchant id this branding describes (stringified bigint). */
  merchantId: string;
  /** The readable business name customers see ("Joe's Barbershop"). */
  name: string;
  /** A short, plain-English one-liner shown under the name. */
  description: string;
  /** The logo as an inline-SVG string, or `null` when none is set. */
  logoSvg: string | null;
  /** A safe `#`-prefixed hex brand color. */
  brandColor: string;
  /**
   * Whether the readable name has been verified to match the on-chain
   * `nameHash` (`keccak256(name) === merchants(id).nameHash`). Only set true
   * by the on-chain resolution path; the badge is shown ONLY when true (law #4).
   */
  verified: boolean;
  /** Epoch-ms the branding was cached, for staleness/debugging. */
  updatedAt: number;
}

/**
 * The Snap's persisted configuration, set by the dapp's `configure` call and
 * stored via `snap_manageState`. The router address is NEVER hardcoded — it
 * lives here so a redeploy is a config change, not a code change.
 */
export interface SnapConfigState {
  /** The deployed `Access0x1Router` address. */
  routerAddress: `0x${string}`;
  /** Chain ids this install recognizes. */
  chainIds: number[];
  /** Persisted receipt log (most-recent-first), capped by the RPC handler. */
  receipts?: SerializedPaymentSummary[];
  /**
   * Base URL of the public branding API, used by `onTransaction` to backfill
   * branding on a fresh device (ADR D4 path 2). Set by `configure`; defaults to
   * the platform API when unset. Display-only — never on a money path.
   */
  brandingApiBaseUrl?: string;
  /**
   * Per-merchant branding cache, keyed by stringified `merchantId`. Pushed in by
   * `setMerchantBranding`; read first by `onTransaction` (ADR D4 path 1). This is
   * an OPTIMIZATION, never the source of truth — the fetch + on-chain paths always
   * backfill a fresh device (ADR D5: `snap_manageState` is per-device).
   */
  branding?: Record<string, MerchantBranding>;
}

/**
 * `PaymentSummary` with `bigint` fields stringified for JSON persistence and
 * the `wallet_invokeSnap` return boundary.
 */
export interface SerializedPaymentSummary
  extends Omit<PaymentSummary, 'merchantId' | 'usdAmount8' | 'tokenAmount'> {
  merchantId: string;
  usdAmount8: string;
  tokenAmount: string;
}
