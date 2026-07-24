/**
 * @file dynamicBoot.ts — the ONE production wiring point that turns the agent's
 * Dynamic MPC wallet + x402 paying fetch from injectable stubs into live clients.
 *
 * Until this module runs, `dynamicAgentWallet.ts` and `payPerCall.ts` ship
 * deliberate throw-by-default seams (`setDynamicClientFactory`,
 * `setWrapFetchWithPayment`) so a missing wiring is LOUD. This module is called
 * once from `instrumentation.ts` at server boot and injects:
 *
 *   1. the REAL `@dynamic-labs-wallet/node-evm` client (v1.0.81, pinned),
 *      adapted to the narrow {@link DynamicEvmWalletClient} interface the unit
 *      was built against — the adapter maps the interface drift found when the
 *      package was pinned (see {@link buildAgentWalletAdapter}); and
 *   2. a paying fetch built on `@circle-fin/x402-batching/client`'s
 *      `BatchEvmScheme` — the SAME Circle Gateway scheme the seller spine
 *      (lib/x402.ts) verifies/settles against, so the agent signs EIP-3009
 *      against the Gateway Wallet domain (`extra.verifyingContract`), never the
 *      bare USDC domain (a generic x402 client would sign the wrong domain).
 *
 * Interface drift captured (v1.0.81, verified against the installed d.ts):
 *  - `authenticateApiToken(token)` — unchanged.
 *  - `createWalletAccount` takes `{ thresholdSignatureScheme, password }` and
 *    returns `{ walletMetadata, publicKeyHex, … }`; the address + wallet id live
 *    on `walletMetadata`.
 *  - There is NO `getWalletAccount(walletId)`; the SDK looks wallets up by
 *    ADDRESS via `fetchWalletMetadata(accountAddress)`. Therefore
 *    `AGENT_WALLET_ID` MUST hold the agent wallet's 0x address (documented in
 *    .env.example); a non-address value is a loud config error.
 *  - `signTypedData` / `signMessage` take the full `walletMetadata` (not a
 *    wallet id); the adapter caches metadata from create/fetch and resolves it
 *    by the wallet id our narrow interface passes.
 *
 * Fail-soft boot: a wiring error leaves the seams unwired (the routes keep
 * their honest not-configured/loud-throw behavior) and logs ONE line — it never
 * crashes the server.
 *
 * Server-only (guardrail #4/#7): imports the node SDK and reads no secrets
 * itself; secrets stay in dynamicAgentWallet/x402Signer.
 */
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { DynamicEvmWalletClient as RealDynamicEvmWalletClient } from "@dynamic-labs-wallet/node-evm";

import {
  setDynamicClientFactory,
  type AgentAccount,
  type DynamicEvmWalletClient,
  type Hex,
  type TypedData,
} from "./dynamicAgentWallet.js";
import {
  setWrapFetchWithPayment,
  type FetchLike,
} from "./payPerCall.js";
import type { AgentX402Account } from "./x402Signer.js";
import { assertServerOnly } from "./serverOnly.js";

assertServerOnly("dynamicBoot");

/** A 0x-prefixed 20-byte EVM address. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The minimal surface of the REAL node-evm client the adapter consumes —
 * structural, so tests inject a plain object and the pinned class satisfies it.
 */
export interface RealEvmClientLike {
  authenticateApiToken(authToken: string): Promise<void>;
  createWalletAccount(args: {
    thresholdSignatureScheme: "TWO_OF_TWO" | "TWO_OF_THREE" | "THREE_OF_FIVE";
    password?: string;
    backUpToDynamic?: boolean;
  }): Promise<{ walletMetadata: RealWalletMetadata; publicKeyHex: string }>;
  fetchWalletMetadata(accountAddress: string): Promise<RealWalletMetadata>;
  signTypedData(args: {
    walletMetadata: RealWalletMetadata;
    typedData: unknown;
    password?: string;
  }): Promise<string>;
  signMessage(args: {
    walletMetadata: RealWalletMetadata;
    message: string;
    password?: string;
  }): Promise<`0x${string}`>;
}

/** The wallet identity the real SDK returns (subset the adapter relies on). */
export interface RealWalletMetadata {
  walletId: string;
  accountAddress: string;
  [key: string]: unknown;
}

/**
 * Adapt the REAL node-evm client to the narrow {@link DynamicEvmWalletClient}
 * interface the rest of the unit depends on. Pure mapping + a per-adapter
 * metadata cache; no env reads, no secrets stored.
 *
 * @param real The real (or test-fake) node-evm client.
 * @returns The narrow client the wallet module expects.
 */
export function buildAgentWalletAdapter(real: RealEvmClientLike): DynamicEvmWalletClient {
  // walletId → full metadata, populated by create/get so sign calls resolve.
  const metaByWalletId = new Map<string, RealWalletMetadata>();

  const toAccount = (meta: RealWalletMetadata, publicKeyHex: string): AgentAccount => {
    metaByWalletId.set(meta.walletId, meta);
    return {
      accountAddress: meta.accountAddress as Hex,
      publicKeyHex,
      walletId: meta.walletId,
    };
  };

  const requireMeta = (walletId: string): RealWalletMetadata => {
    const meta = metaByWalletId.get(walletId);
    if (!meta) {
      // Sign called before create/get — a wiring-order bug, surfaced loudly.
      throw new Error(
        `dynamicBoot: no cached wallet metadata for walletId ${walletId} — ` +
          "getOrCreateAgentAccount() must run before signing.",
      );
    }
    return meta;
  };

  return {
    authenticateApiToken: (token) => real.authenticateApiToken(token),

    async createWalletAccount({ password }) {
      const created = await real.createWalletAccount({
        thresholdSignatureScheme: "TWO_OF_TWO",
        password,
        // Back the external server key shares up to Dynamic so the wallet is
        // recoverable by address on later boots (the slim fetch path below).
        backUpToDynamic: true,
      });
      return toAccount(created.walletMetadata, created.publicKeyHex);
    },

    async getWalletAccount({ walletId }) {
      // v1.0.81 looks wallets up by ADDRESS. AGENT_WALLET_ID therefore holds
      // the wallet's 0x address; anything else is a loud config error (law #4:
      // fail loud, never operate on a guessed wallet).
      if (!ADDRESS_RE.test(walletId)) {
        throw new Error(
          "dynamicBoot: with @dynamic-labs-wallet/node-evm v1, AGENT_WALLET_ID must be " +
            `the agent wallet's 0x address (got "${walletId}"). Set it to the address ` +
            "printed on first boot.",
        );
      }
      const meta = await real.fetchWalletMetadata(walletId);
      // The slim by-address lookup returns identity only — no public key. The
      // field is display-only in this unit; empty is honest (never invented).
      return toAccount(meta, "");
    },

    async signTypedData({ walletId, password, typedData }) {
      const signature = await real.signTypedData({
        walletMetadata: requireMeta(walletId),
        // The SDK's d.ts nominally types this as viem's `TypedData` map, but the
        // runtime consumes the full {domain, types, primaryType, message}
        // payload (formatTypedData) — pass it through unchanged.
        typedData,
        password,
      });
      return signature as Hex;
    },

    async signMessage({ walletId, password, message }) {
      const text =
        typeof message === "string" ? message : new TextDecoder().decode(message);
      return real.signMessage({
        walletMetadata: requireMeta(walletId),
        message: text,
        password,
      });
    },
  };
}

/** Build a narrow client over the REAL pinned SDK for one environment id. */
export function realDynamicClientFactory(environmentId: string): DynamicEvmWalletClient {
  return buildAgentWalletAdapter(
    new RealDynamicEvmWalletClient({ environmentId }) as unknown as RealEvmClientLike,
  );
}

/** Structural scheme surface, so tests can stub payload creation offline. */
export interface PayloadScheme {
  createPaymentPayload(
    x402Version: number,
    requirements: Record<string, unknown>,
  ): Promise<{ x402Version: number; payload: Record<string, unknown> }>;
}

/** Build the Circle Gateway batch scheme over the agent's signing account. */
function defaultSchemeFactory(account: AgentX402Account): PayloadScheme {
  return new BatchEvmScheme({
    address: account.address,
    // BatchEvmSigner passes {domain, types, primaryType, message} — the exact
    // TypedData shape the MPC signer consumes.
    signTypedData: (params) => account.signTypedData(params as unknown as TypedData),
  }) as unknown as PayloadScheme;
}

/**
 * Build a fetch that transparently pays x402-gated endpoints with the SAME
 * Circle Gateway `exact` scheme the seller spine verifies:
 *
 *   1. fire the request; a non-402 response passes through untouched;
 *   2. on 402, read the requirement from the `PAYMENT-REQUIRED` header (the
 *      seller sets it base64-encoded; body `accepts[0]` is the fallback);
 *   3. sign the EIP-3009 authorization via {@link BatchEvmScheme} (Gateway
 *      Wallet domain from `extra.verifyingContract`);
 *   4. retry ONCE with the base64 `payment-signature` header the seller decodes.
 *
 * @param baseFetch The transport to wrap.
 * @param account The agent's signing account (Dynamic MPC via x402Signer).
 * @param schemeFactory Test seam — defaults to the real {@link BatchEvmScheme}.
 * @returns A {@link FetchLike} that pays 402 challenges.
 */
export function buildPayingFetch(
  baseFetch: FetchLike,
  account: AgentX402Account,
  schemeFactory: (account: AgentX402Account) => PayloadScheme = defaultSchemeFactory,
): FetchLike {
  const scheme = schemeFactory(account);
  return async (url, init) => {
    const first = await baseFetch(url, init);
    if (first.status !== 402) return first;

    // The seller broadcasts the requirement in the PAYMENT-REQUIRED header
    // (base64 JSON); the 402 body's accepts[0] is the documented fallback.
    let requirements: Record<string, unknown> | undefined;
    const header = first.headers.get("PAYMENT-REQUIRED");
    if (header) {
      try {
        requirements = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      } catch {
        requirements = undefined;
      }
    }
    if (!requirements) {
      try {
        const body = (await first.json()) as { accepts?: Record<string, unknown>[] };
        requirements = body.accepts?.[0];
      } catch {
        requirements = undefined;
      }
    }
    if (!requirements) return first; // an unreadable challenge stays a 402 (honest)

    const payload = await scheme.createPaymentPayload(1, requirements);
    const headers = new Headers(init?.headers);
    headers.set(
      "payment-signature",
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    );
    return baseFetch(url, { ...init, headers });
  };
}

let wired = false;

/**
 * Install the real Dynamic client factory + paying fetch into the agent seams.
 * Idempotent; called once from instrumentation at server boot. Fail-soft: a
 * throw logs one line and leaves the seams in their loud unwired state.
 *
 * @returns `{ wired }` — false when wiring failed (reason logged, not thrown).
 */
export function wireAgentRuntime(): { wired: boolean } {
  if (wired) return { wired: true };
  try {
    setDynamicClientFactory(realDynamicClientFactory);
    setWrapFetchWithPayment((baseFetch, account) => buildPayingFetch(baseFetch, account));
    wired = true;
    return { wired: true };
  } catch (err) {
    console.error(
      "dynamicBoot: agent runtime wiring failed — agent pay stays unwired:",
      err instanceof Error ? err.message : String(err),
    );
    return { wired: false };
  }
}

/** Test-only: reset the idempotency latch. */
export function __resetDynamicBootForTests(): void {
  wired = false;
}
