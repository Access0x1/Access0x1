/**
 * dynamicBoot.test.ts — the production wiring, offline.
 *
 * Pins the adapter + paying-fetch doctrine of lib/agent/dynamicBoot.ts:
 *  - adapter maps the REAL v1.0.81 surface to the narrow interface:
 *    create passes TWO_OF_TWO + backUpToDynamic and maps walletMetadata;
 *    get requires AGENT_WALLET_ID to be a 0x address (loud otherwise) and
 *    fetches by address; sign resolves cached metadata by walletId and fails
 *    loud when called before create/get;
 *  - buildPayingFetch: non-402 passthrough; 402 → header (or body fallback)
 *    requirement → scheme payload → ONE retry with base64 payment-signature;
 *    unreadable challenge returns the original 402 honestly;
 *  - wireAgentRuntime is idempotent and installs both seams.
 *
 * All collaborators injected/faked — zero network, no real SDK auth.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetDynamicBootForTests,
  buildAgentWalletAdapter,
  buildPayingFetch,
  wireAgentRuntime,
  type PayloadScheme,
  type RealEvmClientLike,
} from "../dynamicBoot.js";
import { setDynamicClientFactory, __resetWalletForTests } from "../dynamicAgentWallet.js";
import { setWrapFetchWithPayment, setBaseFetchForTests } from "../payPerCall.js";
import type { AgentX402Account } from "../x402Signer.js";

const ADDRESS = "0x00000000000000000000000000000000000000aa";
const META = { walletId: "wal-1", accountAddress: ADDRESS };

function makeReal(overrides?: Partial<RealEvmClientLike>): RealEvmClientLike {
  return {
    authenticateApiToken: vi.fn().mockResolvedValue(undefined),
    createWalletAccount: vi
      .fn()
      .mockResolvedValue({ walletMetadata: META, publicKeyHex: "04ab" }),
    fetchWalletMetadata: vi.fn().mockResolvedValue(META),
    signTypedData: vi.fn().mockResolvedValue("0x" + "11".repeat(65)),
    signMessage: vi.fn().mockResolvedValue(("0x" + "22".repeat(65)) as `0x${string}`),
    ...overrides,
  };
}

const ACCOUNT: AgentX402Account = {
  address: ADDRESS as `0x${string}`,
  type: "local",
  signTypedData: vi.fn().mockResolvedValue(("0x" + "33".repeat(65)) as `0x${string}`),
  signMessage: vi.fn().mockResolvedValue(("0x" + "44".repeat(65)) as `0x${string}`),
};

afterEach(() => {
  __resetDynamicBootForTests();
  __resetWalletForTests();
  setDynamicClientFactory(null);
  setWrapFetchWithPayment(null);
  setBaseFetchForTests(null);
});

describe("buildAgentWalletAdapter", () => {
  it("create: passes TWO_OF_TWO + backUpToDynamic and maps walletMetadata to AgentAccount", async () => {
    const real = makeReal();
    const adapter = buildAgentWalletAdapter(real);
    const account = await adapter.createWalletAccount({ password: "pw" });
    expect(real.createWalletAccount).toHaveBeenCalledWith({
      thresholdSignatureScheme: "TWO_OF_TWO",
      password: "pw",
      backUpToDynamic: true,
    });
    expect(account).toEqual({ accountAddress: ADDRESS, publicKeyHex: "04ab", walletId: "wal-1" });
  });

  it("get: fetches by ADDRESS and rejects a non-address AGENT_WALLET_ID loudly", async () => {
    const real = makeReal();
    const adapter = buildAgentWalletAdapter(real);
    const account = await adapter.getWalletAccount({ walletId: ADDRESS, password: "pw" });
    expect(real.fetchWalletMetadata).toHaveBeenCalledWith(ADDRESS);
    expect(account.walletId).toBe("wal-1");
    // The slim lookup returns identity only — publicKeyHex is honestly empty.
    expect(account.publicKeyHex).toBe("");

    await expect(
      adapter.getWalletAccount({ walletId: "wal-1", password: "pw" }),
    ).rejects.toThrow(/must be the agent wallet's 0x address/);
  });

  it("sign: resolves cached metadata by walletId; loud when called before create/get", async () => {
    const real = makeReal();
    const adapter = buildAgentWalletAdapter(real);
    await expect(
      adapter.signTypedData({ walletId: "wal-1", password: "pw", typedData: {} as never }),
    ).rejects.toThrow(/no cached wallet metadata/);

    await adapter.createWalletAccount({ password: "pw" });
    const typedData = { domain: {}, types: {}, primaryType: "T", message: {} };
    const sig = await adapter.signTypedData({ walletId: "wal-1", password: "pw", typedData });
    expect(sig).toBe("0x" + "11".repeat(65));
    expect(real.signTypedData).toHaveBeenCalledWith({
      walletMetadata: META,
      typedData,
      password: "pw",
    });
    // Uint8Array messages are decoded to text for the real client.
    await adapter.signMessage({
      walletId: "wal-1",
      password: "pw",
      message: new TextEncoder().encode("hello"),
    });
    expect(real.signMessage).toHaveBeenCalledWith({
      walletMetadata: META,
      message: "hello",
      password: "pw",
    });
  });
});

describe("buildPayingFetch", () => {
  const REQUIREMENTS = {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "10000",
    payTo: "0x00000000000000000000000000000000000000bb",
    maxTimeoutSeconds: 60,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0xcc" },
  };
  const PAYLOAD = { x402Version: 1, payload: { sig: "0x1" } };

  function schemeFactory(): PayloadScheme {
    return { createPaymentPayload: vi.fn().mockResolvedValue(PAYLOAD) };
  }

  it("passes a non-402 response through untouched (no signing)", async () => {
    const ok = new Response("{}", { status: 200 });
    const base = vi.fn().mockResolvedValue(ok);
    const factory = vi.fn(schemeFactory);
    const paying = buildPayingFetch(base, ACCOUNT, factory);
    expect(await paying("https://x.example/api")).toBe(ok);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("402 → reads PAYMENT-REQUIRED header, signs, retries once with base64 payment-signature", async () => {
    const challenge = new Response(JSON.stringify({ error: "Payment required" }), {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(REQUIREMENTS)).toString("base64"),
      },
    });
    const paid = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const base = vi.fn().mockResolvedValueOnce(challenge).mockResolvedValueOnce(paid);
    const scheme = schemeFactory();
    const paying = buildPayingFetch(base, ACCOUNT, () => scheme);

    const res = await paying("https://x.example/api", { method: "POST" });
    expect(res).toBe(paid);
    expect(scheme.createPaymentPayload).toHaveBeenCalledWith(1, REQUIREMENTS);
    const retryInit = base.mock.calls[1][1] as RequestInit;
    const header = new Headers(retryInit.headers).get("payment-signature")!;
    expect(JSON.parse(Buffer.from(header, "base64").toString("utf8"))).toEqual(PAYLOAD);
  });

  it("402 with no header falls back to body accepts[0]; unreadable challenge returns the 402", async () => {
    const bodyOnly = new Response(JSON.stringify({ accepts: [REQUIREMENTS] }), { status: 402 });
    const paid = new Response("{}", { status: 200 });
    const base = vi.fn().mockResolvedValueOnce(bodyOnly).mockResolvedValueOnce(paid);
    const scheme = schemeFactory();
    expect(await buildPayingFetch(base, ACCOUNT, () => scheme)("https://x.example/a")).toBe(paid);

    const junk = new Response("not json", { status: 402 });
    const base2 = vi.fn().mockResolvedValue(junk);
    const res = await buildPayingFetch(base2, ACCOUNT, schemeFactory)("https://x.example/a");
    expect(res.status).toBe(402);
    expect(base2).toHaveBeenCalledTimes(1); // no blind retry
  });
});

describe("wireAgentRuntime", () => {
  it("is idempotent and reports wired", () => {
    expect(wireAgentRuntime()).toEqual({ wired: true });
    expect(wireAgentRuntime()).toEqual({ wired: true });
  });
});
