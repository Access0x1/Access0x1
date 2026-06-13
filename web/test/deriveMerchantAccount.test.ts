import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the proprietary SDK (spec §6: mock @unlink-xyz/sdk).
//    vi.hoisted so the hoisted vi.mock factory can reference these. ─────────────
const { buildDeriveSeedMessage, fromEthereumSignature } = vi.hoisted(() => {
  const buildDeriveSeedMessage = vi.fn(
    (params: { appId: string; chainId: number }) =>
      `unlink-seed:${params.appId}:${params.chainId}`,
  );
  const fromEthereumSignature = vi.fn(async (params: { signature: string }) => ({
    // Deterministic: same signature in -> same address out (mirrors the real derive).
    address: `0xacc0${params.signature.slice(2, 6)}` as `0x${string}`,
  }));
  return { buildDeriveSeedMessage, fromEthereumSignature };
});

vi.mock("@unlink-xyz/sdk", () => ({
  buildDeriveSeedMessage,
  account: { fromEthereumSignature, fromKeys: vi.fn() },
}));

import { deriveMerchantUnlinkAccount, ARC_CHAIN_ID } from "../lib/unlink/deriveMerchantAccount.js";

const APP_ID = "app_test_123";
const SIGNER_ADDR = "0x1111111111111111111111111111111111111111" as `0x${string}`;

function makeSigner(sig: `0x${string}`) {
  return {
    account: { address: SIGNER_ADDR },
    signMessage: vi.fn(async () => sig),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("deriveMerchantUnlinkAccount", () => {
  beforeEach(() => {
    buildDeriveSeedMessage.mockClear();
    fromEthereumSignature.mockClear();
    // Simulate the browser — the derive is browser-only.
    vi.stubGlobal("window", {} as unknown as Window);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls buildDeriveSeedMessage with { appId, chainId: 5042002 } exactly", async () => {
    const signer = makeSigner("0xdeadbeefcafe");
    await deriveMerchantUnlinkAccount(signer, APP_ID);
    expect(ARC_CHAIN_ID).toBe(5042002);
    expect(buildDeriveSeedMessage).toHaveBeenCalledWith({ appId: APP_ID, chainId: 5042002 });
  });

  it("signs exactly the message returned by buildDeriveSeedMessage", async () => {
    const signer = makeSigner("0xdeadbeefcafe");
    await deriveMerchantUnlinkAccount(signer, APP_ID);
    const expectedMessage = `unlink-seed:${APP_ID}:5042002`;
    expect(signer.signMessage).toHaveBeenCalledWith({
      account: signer.account,
      message: expectedMessage,
    });
  });

  it("calls fromEthereumSignature with { signature, appId, chainId } exactly", async () => {
    const signer = makeSigner("0xdeadbeefcafe");
    await deriveMerchantUnlinkAccount(signer, APP_ID);
    expect(fromEthereumSignature).toHaveBeenCalledWith({
      signature: "0xdeadbeefcafe",
      appId: APP_ID,
      chainId: 5042002,
    });
  });

  it("is deterministic — same sig -> same address", async () => {
    const a = await deriveMerchantUnlinkAccount(makeSigner("0xdeadbeefcafe"), APP_ID);
    const b = await deriveMerchantUnlinkAccount(makeSigner("0xdeadbeefcafe"), APP_ID);
    expect(a.address).toBe(b.address);
  });

  it("server-only guard: throws when window is undefined", async () => {
    vi.unstubAllGlobals(); // no window -> server context
    await expect(deriveMerchantUnlinkAccount(makeSigner("0xabc1"), APP_ID)).rejects.toThrow(
      /browser/i,
    );
  });

  it("requires an appId", async () => {
    await expect(deriveMerchantUnlinkAccount(makeSigner("0xabc1"), "")).rejects.toThrow(/appId/);
  });
});
