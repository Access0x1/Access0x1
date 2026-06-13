/**
 * @file x402Signer.ts — viem-compatible `Account` adapter wrapping the Dynamic MPC signer.
 *
 * Design decision #2 (one booth-uncertain seam, isolated): the exact Dynamic MPC signing
 * method name and whether `x402-fetch` expects a raw viem `Account` or a custom wrapper live
 * ONLY in {@link buildAgentX402Account}. Every other file depends only on the stable shape this
 * function returns — an object with `address`, `type: "local"`, `signTypedData`, `signMessage`.
 *
 * @warn BOOTH-CONFIRM: against `github.com/dynamic-labs-oss/dynamic-agent-payments` confirm
 *   (a) the Dynamic client signing method names (`signTypedData` / `signMessage` here) and
 *   (b) that the installed `x402-fetch` accepts this minimal viem-`Account` shape. Until then
 *   the adapter delegates to the narrow {@link DynamicEvmWalletClient} interface, which keeps
 *   the unit type-checking and testable.
 *
 * Server-only (doctrine guardrail #4 / #7): `WALLET_PASSWORD` is read here and passed only to
 * the Dynamic client. It is NEVER placed on the returned object, never logged, never returned
 * to a caller — the adapter exposes only the address and the two sign methods.
 */

import { assertServerOnly } from "./serverOnly.js";
import {
  getAgentClient,
  getOrCreateAgentAccount,
  type Hex,
  type TypedData,
} from "./dynamicAgentWallet.js";

assertServerOnly("x402Signer");

/** The minimal viem `Account` shape `x402-fetch` consumes to sign EIP-3009 authorizations. */
export interface AgentX402Account {
  /** The MPC wallet address. */
  readonly address: Hex;
  /** viem account kind — `"local"` so x402-fetch signs locally via these methods. */
  readonly type: "local";
  /** Sign EIP-712 typed data (used for EIP-3009 `transferWithAuthorization`). */
  signTypedData(typedData: TypedData): Promise<Hex>;
  /** Sign a raw message. */
  signMessage(args: { message: string | Uint8Array }): Promise<Hex>;
}

/** Read `WALLET_PASSWORD` here so it stays inside the closure and never on the account object. */
function walletPassword(): string {
  const password = process.env.WALLET_PASSWORD;
  if (password === undefined || password === "") {
    // Surface as the same config error the wallet module uses, without echoing the value.
    throw new Error("ConfigMissing: required server env var WALLET_PASSWORD is not set");
  }
  return password;
}

/**
 * Build a viem-compatible account that signs via the Dynamic MPC wallet. The returned object
 * is the ONLY surface other files (payPerCall, unlink-private) depend on — it deliberately
 * exposes just the address and the two sign methods, so the secret password is sealed inside
 * the closure.
 *
 * @returns An {@link AgentX402Account} whose `signTypedData` / `signMessage` delegate to the
 *   Dynamic client without leaking `WALLET_PASSWORD`.
 * @throws {ConfigMissing} (propagated from the wallet module) if auth env vars are unset.
 * @throws {Error} if `WALLET_PASSWORD` is unset.
 */
export async function buildAgentX402Account(): Promise<AgentX402Account> {
  const account = await getOrCreateAgentAccount();
  const { walletId, accountAddress } = account;

  return {
    address: accountAddress,
    type: "local",
    async signTypedData(typedData: TypedData): Promise<Hex> {
      const client = await getAgentClient();
      const password = walletPassword();
      return client.signTypedData({ walletId, password, typedData });
    },
    async signMessage({ message }: { message: string | Uint8Array }): Promise<Hex> {
      const client = await getAgentClient();
      const password = walletPassword();
      return client.signMessage({ walletId, password, message });
    },
  };
}
