/**
 * @file x402Signer.test.ts — viem Account adapter; never leaks WALLET_PASSWORD (RED-first).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentX402Account } from "../x402Signer.js";
import {
  setDynamicClientFactory,
  __resetWalletForTests,
  type DynamicEvmWalletClient,
  type AgentAccount,
  type TypedData,
} from "../dynamicAgentWallet.js";

type SignTypedData = DynamicEvmWalletClient["signTypedData"];
type SignMessage = DynamicEvmWalletClient["signMessage"];

const ACCT: AgentAccount = {
  accountAddress: "0xAGENT0000000000000000000000000000000abc",
  publicKeyHex: "0xpub",
  walletId: "wallet-1",
};

const SECRET = "super-secret-wallet-password";

let signTypedData: ReturnType<typeof vi.fn<SignTypedData>>;
let signMessage: ReturnType<typeof vi.fn<SignMessage>>;

function installMockClient(): void {
  signTypedData = vi.fn<SignTypedData>().mockResolvedValue("0xtypedsig");
  signMessage = vi.fn<SignMessage>().mockResolvedValue("0xmsgsig");
  const client: DynamicEvmWalletClient = {
    authenticateApiToken: vi.fn().mockResolvedValue(undefined),
    createWalletAccount: vi.fn().mockResolvedValue(ACCT),
    getWalletAccount: vi.fn().mockResolvedValue(ACCT),
    signTypedData,
    signMessage,
  };
  setDynamicClientFactory((() => client) as never);
}

const TYPED: TypedData = {
  domain: { name: "USDC", chainId: 5042002 },
  types: { TransferWithAuthorization: [] },
  primaryType: "TransferWithAuthorization",
  message: { from: ACCT.accountAddress, value: "1000" },
};

describe("x402Signer.buildAgentX402Account", () => {
  beforeEach(() => {
    __resetWalletForTests();
    process.env.DYNAMIC_ENVIRONMENT_ID = "env-123";
    process.env.DYNAMIC_AUTH_TOKEN = "tok-abc";
    process.env.WALLET_PASSWORD = SECRET;
    delete process.env.AGENT_WALLET_ID;
    installMockClient();
  });

  afterEach(() => {
    setDynamicClientFactory(null);
    __resetWalletForTests();
  });

  it("returns address, type:'local', signTypedData, signMessage", async () => {
    const account = await buildAgentX402Account();
    expect(account.address).toBe(ACCT.accountAddress);
    expect(account.type).toBe("local");
    expect(typeof account.signTypedData).toBe("function");
    expect(typeof account.signMessage).toBe("function");
  });

  it("signTypedData delegates to the Dynamic client with the wallet password", async () => {
    const account = await buildAgentX402Account();
    const sig = await account.signTypedData(TYPED);
    expect(sig).toBe("0xtypedsig");
    expect(signTypedData).toHaveBeenCalledWith({
      walletId: ACCT.walletId,
      password: SECRET,
      typedData: TYPED,
    });
  });

  it("signMessage delegates without exposing the password on the account object", async () => {
    const account = await buildAgentX402Account();
    const sig = await account.signMessage({ message: "hello" });
    expect(sig).toBe("0xmsgsig");
    // The secret must never appear on the returned object surface.
    expect(JSON.stringify(account)).not.toContain(SECRET);
    expect(Object.values(account)).not.toContain(SECRET);
  });

  it("propagates config errors from the underlying wallet (build throws on missing password)", async () => {
    delete process.env.WALLET_PASSWORD;
    await expect(buildAgentX402Account()).rejects.toThrow(/WALLET_PASSWORD/);
  });

  it("does not leak the password through a deferred sign call either", async () => {
    // With the password present at build, signing must still never echo the secret.
    const account = await buildAgentX402Account();
    await account.signTypedData(TYPED);
    expect(signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({ password: SECRET, walletId: ACCT.walletId }),
    );
    // The secret stays inside the closure, never on the account surface.
    expect(JSON.stringify(account)).not.toContain(SECRET);
  });
});
