/**
 * @file mandate.ts — types for the AP2/A2A mandate interop surface (`POST /api/ap2/mandate`).
 *
 * The rail DERIVES an AP2 mandate chain (Intent ← Cart ← Payment) from an on-chain
 * SessionGrant so an AP2-aware counterparty can verify the agent acted within a
 * user-authorized, bounded, revocable mandate. This endpoint MOVES NO MONEY — it is a
 * pure wire-format view; the on-chain SessionGrant stays the only authority, and every
 * response carries a prominent `onChainTruth` caveat the caller MUST heed.
 *
 * Field names mirror the rail's request contract exactly (grant / cart / payment /
 * options); nothing is invented. Deriving a mandate is an OPTIONAL capability layered on
 * top of the core payment leg — see `Access0x1Payer.deriveMandate`.
 */

/** A 0x-prefixed hex string (address, id, or digest), as the rail's contract expects. */
export type Hex = `0x${string}`;

/**
 * A SessionGrant authorization to express as an AP2 Intent Mandate (rail `grant`).
 * Mirrors the on-chain `SessionGrant.Session` fields — every value is read from (or
 * derivable from) the chain, so the derived mandate is a faithful view, never a claim.
 */
export interface SessionGrantAuthorization {
  /** Deterministic on-chain session id (0x hex). */
  readonly sessionId: Hex;
  /** The granting account — the AP2 "user" who set the scope (0x address). */
  readonly owner: Hex;
  /** The authorized spender — the agent the mandate delegates to (0x address). */
  readonly delegate: Hex;
  /** The spend token contract the budget is denominated in (0x address). */
  readonly token: Hex;
  /** Total spendable budget, decimal string (uint256 precision — never a JS number). */
  readonly budgetCap: string;
  /** Cumulative amount already spent, decimal string. Optional; the rail defaults "0". */
  readonly spent?: string;
  /** Unix-second expiry — the mandate's timing upper bound. */
  readonly expiry: number;
  /** The owner nonce consumed to open the session (replay context). */
  readonly nonce: number;
  /** EVM chain id the SessionGrant lives on. */
  readonly chainId: number;
  /** `true` if the owner revoked the session early. Optional; the rail defaults `false`. */
  readonly revoked?: boolean;
}

/** One cart line item (rail `cart.items[]`). */
export interface CartItem {
  /** Human-readable label. */
  readonly name: string;
  /** Quantity (positive integer). */
  readonly quantity: number;
  /** Unit price in the budget's base units, decimal string. */
  readonly unitPrice: string;
}

/** Cart inputs to derive a Cart Mandate, bound to the Intent Mandate (rail `cart`). */
export interface CartInput {
  /** Stable merchant identifier (the counterparty requesting verification). */
  readonly merchantId: string;
  /** The cart contents. */
  readonly items: readonly CartItem[];
  /** Total cart amount in base units, decimal string. The rail asserts it equals the line-item sum. */
  readonly totalAmount: string;
}

/** x402 rail params to derive a Payment Mandate, bound to the Cart Mandate (rail `payment`). */
export interface PaymentInput {
  /** CAIP-2 / x402 network id, e.g. "eip155:5042002". */
  readonly network: string;
  /** The settlement asset address (USDC), echoing the x402 requirements `asset`. */
  readonly asset: Hex;
  /** The atomic amount charged on the rail (the x402 `amount`, base-unit string). */
  readonly amount: string;
  /** The seller payout address (the x402 `payTo`). */
  readonly payTo: Hex;
  /** The x402 scheme — only "exact" is meaningful for EIP-3009 transferWithAuthorization. */
  readonly scheme?: "exact";
}

/**
 * Optional issuer/time overrides forwarded to the rail's mandate builders (rail
 * `options`). Passed through opaquely — the rail's builder owns the exact schema, so we
 * neither type nor invent its fields here.
 */
export type MandateBuildOptions = Record<string, unknown>;

/** Request to `Access0x1Payer.deriveMandate` (the rail's `POST /api/ap2/mandate` body). */
export interface MandateRequest {
  /** The on-chain SessionGrant to express as an Intent Mandate (required). */
  readonly grant: SessionGrantAuthorization;
  /** Optional cart — adds a Cart Mandate (and, with `payment`, a Payment Mandate). */
  readonly cart?: CartInput;
  /** Optional x402 rail params — required to additionally build a Payment Mandate. */
  readonly payment?: PaymentInput;
  /** Optional issuer/time overrides forwarded to the builders. */
  readonly options?: MandateBuildOptions;
}

/**
 * Result of `Access0x1Payer.deriveMandate`. `mandates` and `onChainTruth` come straight
 * from the rail; the caller MUST heed `onChainTruth` and re-verify the SessionGrant
 * on-chain before trusting any derived mandate.
 */
export interface MandateResult {
  /** The derived mandate chain (intent, optionally cart + payment) — rail `mandates`. */
  readonly mandates: unknown;
  /** `true` when a full Intent←Cart←Payment chain verified its links (rail `linksValid`). */
  readonly linksValid?: boolean;
  /** The rail's unsigned-proof note (rail `note`). */
  readonly note?: string;
  /** The prominent DERIVED-NOT-AUTHORITATIVE caveat (rail `onChainTruth`) — heed it. */
  readonly onChainTruth: string;
  /** The full parsed rail body. */
  readonly raw: unknown;
}
