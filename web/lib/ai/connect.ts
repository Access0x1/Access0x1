/**
 * @file connect.ts — the SDK surface for "connect an AI API". One call,
 * {@link connectAiApi}, turns a SessionGrant grant into a usable API key bound to
 * a budget. This is what a deployment runs (at boot, or from an admin route) after
 * an owner has opened a SessionGrant session on-chain; it never moves money.
 *
 * WHAT IT DOES (pure composition of the rail):
 *   1. Derives the SAME bytes32 session id the SessionGrant contract derives,
 *      `keccak256(abi.encode(owner, delegate, nonce))`, so the off-chain mirror is
 *      keyed identically to the on-chain session (`SessionGrant.computeSessionId`).
 *   2. Opens the off-chain budget mirror for that session id with the grant's
 *      `budgetCap` + `expiry` (`lib/ai/sessionMeter.ts`).
 *   3. Registers the developer's API key against that session + per-call price
 *      (`lib/ai/apiKeys.ts`), storing only the key's hash.
 *
 * After this, an agent calling `/api/ai/chat` with `Authorization: Bearer <key>` is
 * authenticated, budget-capped, and pays per call via x402 — no further wiring.
 *
 * THE BOUNDARY (law #4). This binds an API key to a session whose budget is the
 * grant's `budgetCap`. The AUTHORITATIVE ceiling is still the on-chain SessionGrant;
 * the caller is responsible for actually opening that grant on-chain (via
 * `SessionGrant.openSession`/`openSessionFor`). This helper mirrors that grant at
 * the edge so the gateway can pre-check spends before settling — it does not, and
 * does not claim to, open the on-chain session itself.
 */

import { keccak256, encodeAbiParameters, getAddress, type Hex } from "viem";
import { openSession, type SessionId } from "./sessionMeter.js";
import { registerKey } from "./apiKeys.js";

/** The non-packed encoding of `(owner, delegate, nonce)` — the SessionGrant id legs. */
const SESSION_ID_ABI = [
  { name: "owner", type: "address" },
  { name: "delegate", type: "address" },
  { name: "nonce", type: "uint256" },
] as const;

/**
 * Compute the SessionGrant session id off-chain — byte-for-byte the on-chain
 * `keccak256(abi.encode(owner, delegate, nonce))` (`SessionGrant._sessionId`).
 * Addresses are checksummed first so the id is invariant to input casing.
 *
 * @param owner    The granting account.
 * @param delegate The authorized spender (the agent / server wallet).
 * @param nonce    The owner's SessionGrant nonce the grant was pinned to.
 * @returns The 0x-prefixed bytes32 session id.
 */
export function computeSessionId(owner: Hex, delegate: Hex, nonce: bigint): SessionId {
  return keccak256(
    encodeAbiParameters(SESSION_ID_ABI, [getAddress(owner), getAddress(delegate), nonce]),
  ) as SessionId;
}

/** Inputs to {@link connectAiApi} — a SessionGrant grant + the key to bind to it. */
export interface ConnectAiApiInput {
  /** The granting account (SessionGrant `owner`). */
  readonly owner: Hex;
  /** The authorized spender / agent wallet (SessionGrant `delegate`). */
  readonly delegate: Hex;
  /** The owner nonce the on-chain grant was pinned to (SessionGrant `nonce`). */
  readonly nonce: bigint;
  /** Atomic-USDC total budget (SessionGrant `budgetCap`), e.g. `1_000_000n` = $1.00. */
  readonly budgetCapAtomic: bigint;
  /** Unix-second expiry (SessionGrant `expiry`). Must be in the future. */
  readonly expiry: number;
  /** Per-call price in atomic USDC, e.g. `1000n` for $0.001. Must be > 0. */
  readonly pricePerCallAtomic: bigint;
  /** The plaintext API key to issue to the developer (generated out of band). */
  readonly apiKey: string;
  /** A non-secret label for dashboards/audit. */
  readonly label: string;
}

/** What {@link connectAiApi} returns: the bound session id (the key is the caller's). */
export interface ConnectAiApiResult {
  /** The SessionGrant session id this key spends against (= on-chain id). */
  readonly sessionId: SessionId;
}

/**
 * Connect an AI API: open the off-chain budget mirror for a SessionGrant grant and
 * bind an API key to it. After this call, an agent presenting `apiKey` to a
 * `withAiGateway` endpoint is metered against this session and pays per call.
 *
 * @param input The grant params + the API key to issue. See {@link ConnectAiApiInput}.
 * @returns The {@link ConnectAiApiResult} with the bound session id.
 * @throws {RangeError} if the budget is not positive, the expiry is past, the price
 *         is not positive, or the key is too short (propagated from the meter/store).
 */
export function connectAiApi(input: ConnectAiApiInput): ConnectAiApiResult {
  if (input.pricePerCallAtomic <= 0n) {
    throw new RangeError("connectAiApi: pricePerCallAtomic must be > 0");
  }
  const sessionId = computeSessionId(input.owner, input.delegate, input.nonce);

  // Open the off-chain budget mirror (throws on bad budget/expiry, like on-chain).
  openSession(sessionId, input.budgetCapAtomic, input.expiry);

  // Bind the key to the session + price (stores only the key hash).
  registerKey(input.apiKey, {
    sessionId,
    pricePerCallAtomic: input.pricePerCallAtomic,
    label: input.label,
  });

  return { sessionId };
}
