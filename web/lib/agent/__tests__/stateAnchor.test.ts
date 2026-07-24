/**
 * stateAnchor.test.ts — the earn → store → own loop, offline.
 *
 * Pins the doctrine of lib/agent/stateAnchor.ts:
 *  - dormant seam: AGENT_STATE_ANCHOR unset/false → null, deps never touched;
 *  - stored-only: no anchor writer → blobId + contentHash real, anchored:false;
 *  - stored+anchored: writer present → anchorRelease args exact, anchored:true;
 *  - fail-soft: a Walrus throw → null; an anchor throw → stored-only outcome;
 *  - repoId derivation: keccak256(toBytes(AGENT_REPO_ID)) with documented default.
 *
 * All deps injected via setStateAnchorDeps — zero network.
 */
import { keccak256, toBytes } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  anchorAgentState,
  deriveAgentRepoId,
  isStateAnchorEnabled,
  setStateAnchorDeps,
  type AgentStateReceipt,
  type StateAnchorDeps,
} from "../stateAnchor.js";

const RECEIPT: AgentStateReceipt = {
  url: "https://tool.example/api/quote",
  priceUsd: 0.01,
  agent: "0x1111111111111111111111111111111111111111",
  settledAt: "2026-07-22T18:00:00.000Z",
};

/** The exact bytes the module publishes + hashes (kept in lockstep with impl). */
function receiptBytes(receipt: AgentStateReceipt): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(receipt));
}

function makeDeps(overrides?: Partial<StateAnchorDeps>): {
  deps: StateAnchorDeps;
  publish: ReturnType<typeof vi.fn>;
  writeContract: ReturnType<typeof vi.fn>;
} {
  const publish = vi.fn().mockResolvedValue({ blobId: "blob-123", newlyCreated: true });
  const writeContract = vi.fn().mockResolvedValue("0x" + "ab".repeat(32));
  const deps: StateAnchorDeps = {
    walrus: {
      publish,
      urlFor: (id: string) => `https://agg.example/v1/blobs/${id}`,
    } as StateAnchorDeps["walrus"],
    buildAnchorWriter: () => null,
    ...overrides,
  };
  return { deps, publish, writeContract };
}

afterEach(() => {
  setStateAnchorDeps(null);
  delete process.env.AGENT_STATE_ANCHOR;
  delete process.env.AGENT_REPO_ID;
  vi.useRealTimers();
});

describe("isStateAnchorEnabled", () => {
  it("is false when unset and true only for 'true' (trimmed, case-insensitive)", () => {
    expect(isStateAnchorEnabled()).toBe(false);
    process.env.AGENT_STATE_ANCHOR = "false";
    expect(isStateAnchorEnabled()).toBe(false);
    process.env.AGENT_STATE_ANCHOR = " TRUE ";
    expect(isStateAnchorEnabled()).toBe(true);
  });
});

describe("deriveAgentRepoId", () => {
  it("derives keccak256(toBytes(AGENT_REPO_ID)) — never a hard-coded literal", () => {
    process.env.AGENT_REPO_ID = "github.com/acme/agent";
    expect(deriveAgentRepoId()).toBe(keccak256(toBytes("github.com/acme/agent")));
  });

  it("falls back to the documented default namespace when unset", () => {
    expect(deriveAgentRepoId()).toBe(keccak256(toBytes("access0x1/agent-state")));
  });
});

describe("anchorAgentState", () => {
  it("dormant seam: returns null and never touches deps when disabled", async () => {
    const { deps, publish } = makeDeps();
    setStateAnchorDeps(deps);
    expect(await anchorAgentState(RECEIPT)).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it("stored-only: publishes the exact receipt bytes and reports anchored:false honestly", async () => {
    process.env.AGENT_STATE_ANCHOR = "true";
    const { deps, publish } = makeDeps();
    setStateAnchorDeps(deps);

    const outcome = await anchorAgentState(RECEIPT);
    expect(outcome).not.toBeNull();
    expect(outcome!.blobId).toBe("blob-123");
    expect(outcome!.blobUrl).toBe("https://agg.example/v1/blobs/blob-123");
    // The hash commits to the EXACT published bytes.
    expect(outcome!.contentHash).toBe(keccak256(receiptBytes(RECEIPT)));
    expect(outcome!.anchored).toBe(false);
    expect(outcome!.anchorTx).toBeNull();
    // Published as JSON with the right content type.
    expect(publish).toHaveBeenCalledWith(expect.any(Uint8Array), "application/json");
  });

  it("stored+anchored: calls anchorRelease(repoId, blobId, settledAt, contentHash) and waits for the receipt", async () => {
    process.env.AGENT_STATE_ANCHOR = "true";
    process.env.AGENT_REPO_ID = "access0x1/agent-state";
    const txHash = ("0x" + "cd".repeat(32)) as `0x${string}`;
    const writeContract = vi.fn().mockResolvedValue(txHash);
    const { deps } = makeDeps({
      buildAnchorWriter: () =>
        ({
          walletClient: {
            account: { address: "0x2222222222222222222222222222222222222222" },
            // Base Sepolia is on the admin testnet allowlist, so the receipt
            // wait resolves a real public client; stub the write only.
            chain: { id: 84532, rpcUrls: { default: { http: ["http://x"] } } },
            writeContract,
          },
          registry: "0x3333333333333333333333333333333333333333",
        }) as never,
    });
    // Intercept the receipt wait: the module builds a public client from the
    // admin allowlist — stub the network layer via the deps seam is not enough,
    // so we stub getAdminPublicClient's transport by mocking fetch. Simpler and
    // honest: mock global fetch to answer eth_getTransactionReceipt.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const result =
        body.method === "eth_getTransactionReceipt"
          ? { transactionHash: txHash, status: "0x1", blockNumber: "0x1", blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", from: "0x", to: "0x", cumulativeGasUsed: "0x0", gasUsed: "0x0", logs: [], logsBloom: "0x" + "00".repeat(256), effectiveGasPrice: "0x0", type: "0x2" }
          : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      setStateAnchorDeps(deps);
      const outcome = await anchorAgentState(RECEIPT);
      expect(outcome).not.toBeNull();
      expect(outcome!.anchored).toBe(true);
      expect(outcome!.anchorTx).toBe(txHash);
      // The anchor args are EXACT: repoId, blobId as cid, settledAt as tag, hash.
      expect(writeContract).toHaveBeenCalledTimes(1);
      const call = writeContract.mock.calls[0][0];
      expect(call.functionName).toBe("anchorRelease");
      expect(call.args).toEqual([
        keccak256(toBytes("access0x1/agent-state")),
        "blob-123",
        RECEIPT.settledAt,
        keccak256(receiptBytes(RECEIPT)),
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("fail-soft: a Walrus publish throw resolves to null (money path unaffected)", async () => {
    process.env.AGENT_STATE_ANCHOR = "true";
    const publish = vi.fn().mockRejectedValue(new Error("publisher down"));
    const { deps } = makeDeps();
    (deps.walrus as unknown as { publish: typeof publish }).publish = publish;
    setStateAnchorDeps(deps);
    expect(await anchorAgentState(RECEIPT)).toBeNull();
  });

  it("fail-soft: an anchor-leg throw still returns the stored-only outcome", async () => {
    process.env.AGENT_STATE_ANCHOR = "true";
    const { deps } = makeDeps({
      buildAnchorWriter: () => {
        throw new Error("bad key");
      },
    });
    setStateAnchorDeps(deps);
    const outcome = await anchorAgentState(RECEIPT);
    expect(outcome).not.toBeNull();
    expect(outcome!.blobId).toBe("blob-123");
    expect(outcome!.anchored).toBe(false);
  });

  it("bounded: a hung Walrus publish times out to null (never stalls the reply)", async () => {
    vi.useFakeTimers();
    process.env.AGENT_STATE_ANCHOR = "true";
    const publish = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const { deps } = makeDeps();
    (deps.walrus as unknown as { publish: typeof publish }).publish = publish;
    setStateAnchorDeps(deps);
    const p = anchorAgentState(RECEIPT);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBeNull();
  });

  it("bounded: a hung anchor tx times out to the stored-only outcome", async () => {
    vi.useFakeTimers();
    process.env.AGENT_STATE_ANCHOR = "true";
    const writeContract = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const { deps } = makeDeps({
      buildAnchorWriter: () =>
        ({
          walletClient: {
            account: { address: "0x2222222222222222222222222222222222222222" },
            chain: { id: 84532, rpcUrls: { default: { http: ["http://x"] } } },
            writeContract,
          },
          registry: "0x3333333333333333333333333333333333333333",
        }) as never,
    });
    setStateAnchorDeps(deps);
    const p = anchorAgentState(RECEIPT);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await p;
    expect(outcome).not.toBeNull();
    expect(outcome!.blobId).toBe("blob-123");
    expect(outcome!.anchored).toBe(false);
  });
});
