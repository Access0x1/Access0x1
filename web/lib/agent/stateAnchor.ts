/**
 * stateAnchor.ts — the agent's earn → store → own loop (best-effort, fail-soft).
 *
 * After a settled x402 payment, persist the agent's receipt/state durably and
 * verifiably, using ONLY seams this repo already ships:
 *
 *   1. STORE  — publish the receipt JSON to Walrus (lib/walrus.ts) and get back
 *      a content-addressed `blobId` any aggregator can serve.
 *   2. HASH   — keccak256 over the EXACT published bytes (the content hash the
 *      anchor commits to; a full Merkle tree is not needed for a single blob).
 *   3. ANCHOR — `anchorRelease(repoId, blobId, tag, contentHash)` on the
 *      Access0x1ProvenanceRegistry (lib/admin/provenanceRegistry.ts vendored
 *      abi), so the blob's existence + hash are on-chain, owned by the agent's
 *      anchor wallet.
 *
 * Doctrine:
 *  - law #5 (money paths never swallow — but telemetry never blocks money):
 *    this module is the recordPayment mirror — EVERY error resolves to a
 *    partial/none outcome; it never throws into the pay path.
 *  - law #4 (truth in copy): the outcome states exactly what happened —
 *    `stored` (blobId real), `anchored` (tx real) — never a claimed anchor
 *    without a mined tx. A missing anchor config yields stored-only, honestly.
 *  - TESTNET ONLY writes: the anchor leg reuses the admin testnet allowlist
 *    (getAdminChain) so a mainnet chain id can never reach a write here.
 *  - Server-only: the anchor key is a low-value TESTNET EOA read from server
 *    env; assertServerOnly() guards the import like the other agent modules.
 *
 * Dormant by default: without `AGENT_STATE_ANCHOR=true` the exported
 * `anchorAgentState` returns null and touches nothing (additive seam).
 */
import {
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getAdminChain, getAdminPublicClient, REGISTRY_ABI } from "../admin/provenanceRegistry.js";
import { WalrusClient } from "../walrus.js";
import { assertServerOnly } from "./serverOnly.js";

assertServerOnly("stateAnchor");

/** The receipt/state payload persisted after a settled agent payment. */
export interface AgentStateReceipt {
  /** The paid endpoint URL. */
  url: string;
  /** The per-call USD price that settled. */
  priceUsd: number;
  /** The agent's paying wallet address. */
  agent: string;
  /** ISO timestamp of the settle. */
  settledAt: string;
  /** Optional upstream result summary (bounded by the caller). */
  result?: unknown;
}

/** What actually happened, stated honestly (law #4). */
export interface StateAnchorOutcome {
  /** Content-addressed Walrus blob id of the stored receipt. */
  blobId: string;
  /** Public aggregator URL for the blob. */
  blobUrl: string;
  /** keccak256 of the exact published bytes (the anchored content hash). */
  contentHash: Hex;
  /** The anchor tx hash when the on-chain leg ran, else null (stored-only). */
  anchorTx: Hash | null;
  /** True IFF the anchorRelease tx was mined. */
  anchored: boolean;
}

/** Injectable deps so tests run with zero network (repo pattern: setDynamicClientFactory). */
export interface StateAnchorDeps {
  walrus: Pick<WalrusClient, "publish" | "urlFor">;
  /** Build the anchor wallet client + address, or null when unconfigured. */
  buildAnchorWriter: () => { walletClient: WalletClient; registry: Address } | null;
}

let depsOverride: StateAnchorDeps | null = null;

/** Test-only: inject fakes (pass null to restore the real deps). */
export function setStateAnchorDeps(deps: StateAnchorDeps | null): void {
  depsOverride = deps;
}

/** True when the seam is switched on via env. */
export function isStateAnchorEnabled(): boolean {
  return (process.env.AGENT_STATE_ANCHOR ?? "").trim().toLowerCase() === "true";
}

/**
 * Derive the agent's repoId — keccak256(toBytes(AGENT_REPO_ID)) — the SAME
 * derivation the admin page documents, so a claim made with this string is the
 * exact bytes32 anchored under. Falls back to a documented default namespace.
 */
export function deriveAgentRepoId(): Hex {
  const repoString = (process.env.AGENT_REPO_ID ?? "").trim() || "access0x1/agent-state";
  return keccak256(toBytes(repoString));
}

/** Build the real deps from env (lazy — only when the seam is enabled). */
function realDeps(): StateAnchorDeps {
  const walrus = new WalrusClient({
    publisher: (process.env.WALRUS_PUBLISHER ?? "").trim() || undefined,
    aggregator: (process.env.WALRUS_AGGREGATOR ?? "").trim() || undefined,
  });
  return {
    walrus,
    buildAnchorWriter: () => {
      const key = (process.env.AGENT_ANCHOR_PRIVATE_KEY ?? "").trim();
      const registry = (process.env.AGENT_ANCHOR_REGISTRY ?? "").trim();
      const chainId = Number(process.env.AGENT_ANCHOR_CHAIN_ID ?? "");
      if (!key || !registry || !Number.isInteger(chainId)) return null;
      // TESTNET gate: only the admin allowlist chains may receive a write.
      const entry = getAdminChain(chainId);
      if (!entry) return null;
      const account = privateKeyToAccount(key as Hex);
      const walletClient = createWalletClient({
        account,
        chain: entry.chain,
        transport: http(entry.chain.rpcUrls.default.http[0]),
      });
      return { walletClient, registry: registry as Address };
    },
  };
}

/**
 * Store + anchor an agent receipt, best-effort. NEVER throws; a dormant seam,
 * a storage error, or an anchor error each resolve to null / a partial outcome
 * so the money path is fully insulated (recordPayment mirror).
 *
 * @param receipt - the settled-payment receipt/state to persist.
 * @returns the honest outcome, or null when dormant / nothing was stored.
 */
export async function anchorAgentState(
  receipt: AgentStateReceipt,
): Promise<StateAnchorOutcome | null> {
  if (!isStateAnchorEnabled()) return null;
  try {
    const deps = depsOverride ?? realDeps();

    // 1. STORE — the exact bytes we hash are the exact bytes we publish.
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    const published = await deps.walrus.publish(bytes, "application/json");
    const contentHash = keccak256(bytes);

    const outcome: StateAnchorOutcome = {
      blobId: published.blobId,
      blobUrl: deps.walrus.urlFor(published.blobId),
      contentHash,
      anchorTx: null,
      anchored: false,
    };

    // 2. ANCHOR — optional leg; unconfigured → stored-only outcome (honest).
    try {
      const writer = deps.buildAnchorWriter();
      if (writer) {
        const { walletClient, registry } = writer;
        const account = walletClient.account;
        if (account) {
          const txHash = await walletClient.writeContract({
            account,
            chain: walletClient.chain,
            address: registry,
            abi: REGISTRY_ABI,
            functionName: "anchorRelease",
            args: [deriveAgentRepoId(), published.blobId, receipt.settledAt, contentHash],
          });
          // Wait for the receipt so `anchored: true` is a MINED claim (law #4).
          const publicClient = getAdminPublicClient(walletClient.chain!.id);
          await publicClient.waitForTransactionReceipt({ hash: txHash });
          outcome.anchorTx = txHash;
          outcome.anchored = true;
        }
      }
    } catch {
      // Anchor leg failed — the stored-only outcome below is still true & useful.
    }

    return outcome;
  } catch {
    // Storage failed — nothing persisted; the pay path continues unaffected.
    return null;
  }
}
