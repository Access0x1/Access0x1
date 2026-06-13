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
