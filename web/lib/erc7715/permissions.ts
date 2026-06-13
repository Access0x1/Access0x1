/**
 * @file permissions.ts — the ERC-7715 / ERC-7710 interop adapter (an off-chain SERIALIZER seam).
 *
 * Access0x1's enforcing core is on-chain: SessionGrant (`src/SessionGrant.sol`) is the budget-capped,
 * time-bounded, owner-revocable ERC-7702/6492/1271 mandate; `spend()` is the debit; `revoke()` is the
 * kill-switch. This file is a PURE, additive view layer — the twin of `lib/ap2/mandate.ts` — that
 * re-expresses a SessionGrant in the nouns of the EMERGING wallet spend-permissions standard so a
 * 7715-aware wallet (MetaMask Advanced Permissions, Rhinestone, Biconomy) and a 7710-aware delegate
 * (the MetaMask Delegation Toolkit) can speak to Access0x1 with zero bespoke code.
 *
 * THE STANDARDS TWIN (verified against build-specs/emerging-erc.adr.md §Q1):
 *   - ERC-7715 `wallet_requestExecutionPermissions` (a user grants an agent a scoped, expiring,
 *     budget-capped spend permission and gets back an opaque `context`) == `SessionGrant.openSessionFor`.
 *     SessionGrant already accepts ECDSA / ERC-1271 / ERC-6492 signatures, so ANY 7715-capable wallet
 *     (incl. a counterfactual smart account) can authorize a session TODAY.
 *   - The opaque 7715 `context` == `abi.encode(address sessionGrant, bytes32 sessionId)`. A delegate
 *     that "holds a 7715 permission" is just holding a SessionGrant `(address, sessionId)` in 7715
 *     clothing; the context tells a 7710 redemption EXACTLY which SessionGrant + session to spend on.
 *   - ERC-7710 `redeemDelegations(permissionContexts, modes, executionCallDatas)` == `SessionGrant.spend`.
 *     The redemption descriptor this module builds points at `SessionGrant.spend(sessionId, amount)`.
 *   - 7715's owner-revocation == `SessionGrant.revoke(sessionId)`.
 *
 * MAPPING TABLE (7715 permission shape → openSessionFor params):
 *   | ERC-7715 field                          | SessionGrant.openSessionFor param         |
 *   |-----------------------------------------|-------------------------------------------|
 *   | `signer` (the delegate/session account) | `delegate`                                |
 *   | `permission.data.token` (erc20 stream)  | (token — denomination context, see note)  |
 *   | `permission.data.allowance|amount`      | `budgetCap`                               |
 *   | `expiry` (the `expiry` rule, unix sec)  | `expiry`                                  |
 *   | owner-supplied / wallet `account`       | `owner` (passed in, signs the grant)      |
 *   | (replay) wallet nonce                   | `nonce` (the SessionGrant owner nonce)    |
 *
 * NOTE ON `token`: SessionGrant is a pure AUTHORIZATION ledger — it stores budgetCap + expiry +
 * delegate + nonce, NOT the token (custody/denomination lives on the consuming router, money-safety invariant).
 * So `token` is carried through this adapter as interop METADATA (which asset the 7715 allowance is
 * denominated in) and is NOT a SessionGrant constructor arg. The honest mapping surfaces it on the
 * descriptor for the consumer, never pretends SessionGrant enforces it.
 *
 * DOCTRINE:
 *  - Moves NO money, holds NO custody, reads NO env, makes NO network call — pure transforms only
 *    (off the money path by construction, exactly like `lib/ap2/mandate.ts`).
 *  - law #4 (truth in copy): this is the OFF-CHAIN interop seam. The on-chain 7710 `redeemDelegations`
 *    router facade and the Coinbase-SpendPermissions bridge are DEFERRED to post-event (they touch the
 *    money path + need audit). This module makes us SPEAK 7715/7710 in the SDK/interop layer; it does
 *    not change the enforcing on-chain path. The descriptor it emits is a faithful call-shape, not a
 *    claim that a router is already wired.
 *  - Pure + deterministic: every function is a pure function of its inputs (no clock, no randomness).
 *
 * SOURCES: ERC-7715 (eips.ethereum.org/EIPS/eip-7715), ERC-7710 redeemDelegations
 * (github.com/MetaMask/delegation-framework IDelegationManager), per the project ADR.
 */

import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  isAddress,
  isHex,
} from "viem";

/** A 0x-prefixed hex string (an EVM address, a bytes32 session id, or encoded bytes). */
export type Hex = `0x${string}`;

/**
 * The ERC-7715 permission TYPES this adapter understands. The EIP defines these as examples and is
 * intentionally non-exhaustive; these are the two that map cleanly onto a SessionGrant budget cap.
 *  - `native-token-stream` / `native-token-periodic`: a streaming/periodic native-token allowance.
 *  - `erc20-token-stream` / `erc20-token-periodic`: the same for an ERC-20 (the Access0x1 USDC case).
 * We accept any of these and treat the allowance/amount as the SessionGrant `budgetCap` ceiling. Any
 * unknown type is rejected loudly (law #4 — never silently coerce a permission we don't model).
 */
export const SUPPORTED_PERMISSION_TYPES = [
  "native-token-stream",
  "native-token-periodic",
  "erc20-token-stream",
  "erc20-token-periodic",
] as const;

export type SupportedPermissionType = (typeof SUPPORTED_PERMISSION_TYPES)[number];

/** True for the two ERC-20 permission shapes (which carry a `token` address in `permission.data`). */
function isErc20PermissionType(type: string): boolean {
  return type === "erc20-token-stream" || type === "erc20-token-periodic";
}

/* ───────────────────────────── ERC-7715 request shape (inputs) ───────────────────────────── */

/**
 * An ERC-7715 permission, in the EIP's `{ type, data }` shape. `data` is permission-type specific; we
 * model the fields a token allowance carries. Extra fields are ignored (forward-compatible).
 */
export interface Erc7715Permission {
  /** The permission type, e.g. "erc20-token-periodic". MUST be one of {@link SUPPORTED_PERMISSION_TYPES}. */
  readonly type: string;
  /** Permission-type-specific data. */
  readonly data: {
    /** The token contract for an erc20-* permission (omitted/native for native-token-*). */
    readonly token?: Hex;
    /** The allowance ceiling, as a decimal string in base units (uint256 — never a JS number). The
     *  EIP uses `allowance` for streams and `amount`/`periodAmount` for periodic; we accept any of
     *  them via {@link extractAllowance}. */
    readonly allowance?: string;
    /** Alternate allowance key used by periodic permissions. */
    readonly amount?: string;
    /** Alternate allowance key used by some periodic-permission implementations. */
    readonly periodAmount?: string;
  };
}

/**
 * A single ERC-7715 permissions request, as passed to `wallet_requestExecutionPermissions`. We model
 * the fields needed to open a SessionGrant; chainId/address fields beyond these are carried as metadata.
 */
export interface Erc7715Request {
  /** CAIP-2-style numeric chain id the permission is requested on (e.g. Arc Testnet 5042002). */
  readonly chainId: number;
  /** The account GRANTING the permission (the SessionGrant `owner`). The wallet signs the grant. */
  readonly account: Hex;
  /** The session/delegate account the permission is granted TO (the SessionGrant `delegate`). Per the
   *  EIP this is the `signer` of type `account`; we accept the address directly. */
  readonly signer: Hex;
  /** The requested permission (token allowance). */
  readonly permission: Erc7715Permission;
  /** The expiry, in unix SECONDS — the EIP's `expiry` rule. MUST be in the future at grant time
   *  (SessionGrant enforces `expiry > block.timestamp` on-chain; we surface it here unchanged). */
  readonly expiry: number;
  /** The SessionGrant owner nonce to pin this grant to (the replay context). Defaults to 0 if omitted —
   *  callers that read `SessionGrant.nonces(owner)` on-chain should pass the live value. */
  readonly nonce?: number;
}

/* ───────────────────────────── outputs ───────────────────────────── */

/**
 * SessionGrant.openSessionFor params derived from a 7715 request. `owner` + `delegate` + `budgetCap`
 * + `expiry` + `nonce` are the exact on-chain call args; `token` is interop metadata (see file note).
 * All amounts are decimal strings to preserve uint256 precision.
 */
export interface OpenSessionForParams {
  /** SessionGrant.openSessionFor `owner` (the granting wallet — checksummed). */
  readonly owner: Hex;
  /** SessionGrant.openSessionFor `delegate` (the 7715 `signer` — checksummed). */
  readonly delegate: Hex;
  /** SessionGrant.openSessionFor `budgetCap`, decimal string (uint256), from the 7715 allowance. */
  readonly budgetCap: string;
  /** SessionGrant.openSessionFor `expiry` (unix seconds, uint64-range). */
  readonly expiry: number;
  /** The owner nonce the grant is pinned to (uint256). */
  readonly nonce: number;
  /** The chain id the SessionGrant lives on (passthrough from the request). */
  readonly chainId: number;
  /** INTEROP METADATA: which token the 7715 allowance is denominated in. `null` for native-token-*.
   *  NOT a SessionGrant arg — denomination/custody lives on the consuming router. */
  readonly token: Hex | null;
  /** The permission type this was derived from (audit trail). */
  readonly permissionType: SupportedPermissionType;
}

/**
 * An ERC-7710 redemption descriptor, shaped like `redeemDelegations(bytes[] permissionContexts,
 * ModeCode[] modes, bytes[] executionCallDatas)` but pointed at `SessionGrant.spend`. This is the
 * call-shape a 7710-aware delegate would build to spend within the granted scope. It is a DESCRIPTOR
 * (the off-chain seam), not an on-chain router facade — the facade is deferred (file note, law #4).
 */
export interface Erc7710RedemptionDescriptor {
  /** The opaque 7715 `context` = abi.encode(address sessionGrant, bytes32 sessionId). The 7710
   *  `permissionContext` for this redemption. */
  readonly permissionContext: Hex;
  /** The SessionGrant contract the redemption targets (decoded from the context — checksummed). */
  readonly target: Hex;
  /** The session id within that SessionGrant the spend debits. */
  readonly sessionId: Hex;
  /** The function on `target` a redemption calls — always `SessionGrant.spend` for this seam. */
  readonly method: "spend";
  /** The amount to spend on this redemption, decimal string (uint256), within the session budget. */
  readonly amount: string;
  /** The exact tuple `SessionGrant.spend(bytes32 sessionId, uint256 amount)` is called with. This is
   *  the `executionCallData` a 7710 redemption would carry, pre-ABI-encoding. */
  readonly call: {
    readonly sessionId: Hex;
    readonly amount: string;
  };
}

/* ───────────────────────────── context codec (abi.encode) ───────────────────────────── */

/** The ABI tuple the opaque 7715 `context` is `abi.encode`d as: (address sessionGrant, bytes32 sessionId). */
const CONTEXT_ABI = [
  { name: "sessionGrant", type: "address" },
  { name: "sessionId", type: "bytes32" },
] as const;

/**
 * Encode the opaque ERC-7715 `context` for a SessionGrant session.
 *
 * The context is `abi.encode(address sessionGrant, bytes32 sessionId)` — the minimal pointer a 7710
 * redemption needs to know WHICH SessionGrant and WHICH session to spend against. A 7715 wallet stores
 * this opaque blob; the delegate replays it as the 7710 `permissionContext`.
 *
 * @param sessionGrant - the SessionGrant contract address.
 * @param sessionId    - the bytes32 session id (= keccak256(owner, delegate, nonce) on-chain).
 * @returns the abi-encoded context (hex).
 * @throws if `sessionGrant` is not a valid address or `sessionId` is not a 32-byte hex value.
 */
export function encodeContext(sessionGrant: Hex, sessionId: Hex): Hex {
  if (!isAddress(sessionGrant)) {
    throw new Error(`encodeContext: invalid SessionGrant address: ${sessionGrant}`);
  }
  if (!isHex(sessionId) || sessionId.length !== 66) {
    throw new Error(`encodeContext: sessionId must be 32-byte hex (0x + 64 chars), got: ${sessionId}`);
  }
  return encodeAbiParameters(CONTEXT_ABI, [getAddress(sessionGrant), sessionId]);
}

/** The decoded contents of a 7715 `context`. */
export interface DecodedContext {
  /** The SessionGrant contract the context points at (checksummed). */
  readonly sessionGrant: Hex;
  /** The session id within that SessionGrant. */
  readonly sessionId: Hex;
}

/**
 * Decode an opaque ERC-7715 `context` back into its `(sessionGrant, sessionId)` pair. Round-trips with
 * {@link encodeContext} exactly (the address is returned checksummed).
 *
 * @param context - the abi-encoded context produced by {@link encodeContext}.
 * @returns the decoded `{ sessionGrant, sessionId }`.
 * @throws if `context` is not valid hex or does not decode to the expected tuple.
 */
export function decodeContext(context: Hex): DecodedContext {
  if (!isHex(context)) {
    throw new Error(`decodeContext: context must be hex, got: ${context}`);
  }
  const [sessionGrant, sessionId] = decodeAbiParameters(CONTEXT_ABI, context);
  return { sessionGrant: getAddress(sessionGrant as Hex), sessionId: sessionId as Hex };
}

/* ───────────────────────────── helpers (pure) ───────────────────────────── */

/**
 * Extract the allowance ceiling (the SessionGrant `budgetCap`) from a 7715 permission's `data`,
 * accepting the `allowance` (stream) / `amount` / `periodAmount` (periodic) keys the EIP and its
 * implementations use. Returns the value as a validated decimal string.
 *
 * @throws if no recognized allowance key is present, or the value is not a non-negative integer string.
 */
export function extractAllowance(data: Erc7715Permission["data"]): string {
  const raw = data.allowance ?? data.amount ?? data.periodAmount;
  if (raw === undefined) {
    throw new Error(
      "grantToSessionParams: permission.data has no allowance/amount/periodAmount (the 7715 budget).",
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`grantToSessionParams: allowance must be a base-10 integer string, got: ${raw}`);
  }
  return raw;
}

/* ───────────────────────────── builders (pure) ───────────────────────────── */

/**
 * Map an ERC-7715 permissions request onto `SessionGrant.openSessionFor` params.
 *
 * This is the heart of "speaking 7715": a wallet's scoped, expiring, budget-capped spend permission
 * becomes the exact on-chain call that opens the equivalent SessionGrant. The owner signs the
 * SessionGrant EIP-712 digest (SessionGrant already accepts ECDSA / 1271 / 6492), and a relayer
 * submits `openSessionFor(owner, delegate, budgetCap, expiry, signature)`.
 *
 * @param request - the ERC-7715 request (`wallet_requestExecutionPermissions` shape).
 * @returns the {@link OpenSessionForParams} to call SessionGrant with.
 * @throws if the permission type is unsupported, addresses are invalid, the expiry is non-positive,
 *         or the allowance is missing/malformed (law #4 — reject, never silently coerce).
 */
export function grantToSessionParams(request: Erc7715Request): OpenSessionForParams {
  const { permission } = request;
  if (!SUPPORTED_PERMISSION_TYPES.includes(permission.type as SupportedPermissionType)) {
    throw new Error(
      `grantToSessionParams: unsupported permission type "${permission.type}". ` +
        `Supported: ${SUPPORTED_PERMISSION_TYPES.join(", ")}.`,
    );
  }
  const permissionType = permission.type as SupportedPermissionType;

  if (!isAddress(request.account)) {
    throw new Error(`grantToSessionParams: invalid account (owner) address: ${request.account}`);
  }
  if (!isAddress(request.signer)) {
    throw new Error(`grantToSessionParams: invalid signer (delegate) address: ${request.signer}`);
  }
  if (!Number.isInteger(request.expiry) || request.expiry <= 0) {
    throw new Error(`grantToSessionParams: expiry must be a positive unix-second integer, got: ${request.expiry}`);
  }
  if (request.nonce !== undefined && (!Number.isInteger(request.nonce) || request.nonce < 0)) {
    throw new Error(`grantToSessionParams: nonce must be a non-negative integer, got: ${request.nonce}`);
  }

  const budgetCap = extractAllowance(permission.data);
  if (budgetCap === "0") {
    // Mirror SessionGrant's on-chain SessionGrant__ZeroBudget guard — a budgetless grant is meaningless.
    throw new Error("grantToSessionParams: a zero allowance maps to a zero budgetCap (rejected on-chain).");
  }

  // Token: present + validated for erc20-* permissions; null for native-token-*.
  let token: Hex | null = null;
  if (isErc20PermissionType(permissionType)) {
    if (!permission.data.token || !isAddress(permission.data.token)) {
      throw new Error(
        `grantToSessionParams: an erc20 permission requires a valid data.token, got: ${permission.data.token}`,
      );
    }
    token = getAddress(permission.data.token);
  }

  return {
    owner: getAddress(request.account),
    delegate: getAddress(request.signer),
    budgetCap,
    expiry: request.expiry,
    nonce: request.nonce ?? 0,
    chainId: request.chainId,
    token,
    permissionType,
  };
}

/**
 * Build an ERC-7710 redemption descriptor (the `redeemDelegations`-shaped call) that spends `amount`
 * against the SessionGrant session encoded in `context`. The descriptor decodes the opaque 7715
 * `context` to learn the target SessionGrant + sessionId, then points the redemption at
 * `SessionGrant.spend(sessionId, amount)`.
 *
 * This is the call-shape a 7710-aware delegate (e.g. a MetaMask Delegation Toolkit agent) would
 * construct to spend within the granted scope — making "the router that already speaks 7710" literal
 * at the SDK seam. The on-chain `redeemDelegations` router FACADE that would consume this is deferred
 * to post-event (file note, law #4): this descriptor is a faithful call-shape, not a deployed router.
 *
 * @param context - the opaque 7715 context (= encodeContext(sessionGrant, sessionId)).
 * @param amount  - the amount to spend on this redemption, decimal string (uint256), within budget.
 * @returns the {@link Erc7710RedemptionDescriptor}.
 * @throws if the context is malformed or the amount is not a positive integer string.
 */
export function buildRedemptionDescriptor(context: Hex, amount: string): Erc7710RedemptionDescriptor {
  const { sessionGrant, sessionId } = decodeContext(context);
  if (!/^\d+$/.test(amount)) {
    throw new Error(`buildRedemptionDescriptor: amount must be a base-10 integer string, got: ${amount}`);
  }
  if (amount === "0") {
    // Mirror SessionGrant's on-chain SessionGrant__ZeroAmount guard.
    throw new Error("buildRedemptionDescriptor: a zero spend amount is rejected on-chain (SessionGrant__ZeroAmount).");
  }
  return {
    permissionContext: context,
    target: sessionGrant,
    sessionId,
    method: "spend",
    amount,
    call: { sessionId, amount },
  };
}
