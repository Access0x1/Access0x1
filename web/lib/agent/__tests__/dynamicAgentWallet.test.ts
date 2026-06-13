/**
 * @file dynamicAgentWallet.test.ts — lazy auth singleton + create-once/reuse (RED-first).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  getAgentClient,
  getOrCreateAgentAccount,
  agentAddress,
  setDynamicClientFactory,
  ConfigMissing,
  __resetWalletForTests,
  type DynamicEvmWalletClient,
  type AgentAccount,
} from "../dynamicAgentWallet.js";

const ACCT: AgentAccount = {
  accountAddress: "0xAGENT0000000000000000000000000000000abc",
  publicKeyHex: "0xpub",
  walletId: "wallet-created-1",
};

const EXISTING: AgentAccount = {
  accountAddress: "0xEXISTING000000000000000000000000000000ab",
  publicKeyHex: "0xpub2",
  walletId: "wallet-existing-9",
};

interface Spies {
  authenticateApiToken: ReturnType<typeof vi.fn>;
  createWalletAccount: ReturnType<typeof vi.fn>;
  getWalletAccount: ReturnType<typeof vi.fn>;
  factory: ReturnType<typeof vi.fn>;
  client: DynamicEvmWalletClient;
}

function installMockClient(): Spies {
  const authenticateApiToken = vi.fn().mockResolvedValue(undefined);
  const createWalletAccount = vi.fn().mockResolvedValue(ACCT);
  const getWalletAccount = vi.fn().mockResolvedValue(EXISTING);
  const client: DynamicEvmWalletClient = {
    authenticateApiToken,
    createWalletAccount,
    getWalletAccount,
    signTypedData: vi.fn().mockResolvedValue("0xsig"),
    signMessage: vi.fn().mockResolvedValue("0xsig"),
  };
  const factory = vi.fn().mockReturnValue(client);
  setDynamicClientFactory(factory as never);
  return { authenticateApiToken, createWalletAccount, getWalletAccount, factory, client };
}

describe("dynamicAgentWallet", () => {
  beforeEach(() => {
    __resetWalletForTests();
    process.env.DYNAMIC_ENVIRONMENT_ID = "env-123";
    process.env.DYNAMIC_AUTH_TOKEN = "tok-abc";
    process.env.WALLET_PASSWORD = "pw-xyz";
    delete process.env.AGENT_WALLET_ID;
  });

  afterEach(() => {
    setDynamicClientFactory(null);
    __resetWalletForTests();
  });

  it("throws ConfigMissing when DYNAMIC_ENVIRONMENT_ID is absent", async () => {
    installMockClient();
    delete process.env.DYNAMIC_ENVIRONMENT_ID;
    await expect(getAgentClient()).rejects.toBeInstanceOf(ConfigMissing);
  });

  it("throws ConfigMissing when DYNAMIC_AUTH_TOKEN is absent", async () => {
    installMockClient();
    delete process.env.DYNAMIC_AUTH_TOKEN;
    await expect(getAgentClient()).rejects.toBeInstanceOf(ConfigMissing);
  });

  it("throws ConfigMissing when WALLET_PASSWORD is absent", async () => {
    installMockClient();
    delete process.env.WALLET_PASSWORD;
    await expect(getOrCreateAgentAccount()).rejects.toBeInstanceOf(ConfigMissing);
  });

  it("authenticates exactly once across many getAgentClient calls", async () => {
    const spies = installMockClient();
    await Promise.all([getAgentClient(), getAgentClient(), getAgentClient()]);
    await getAgentClient();
    expect(spies.authenticateApiToken).toHaveBeenCalledTimes(1);
    expect(spies.factory).toHaveBeenCalledTimes(1);
  });

  it("creates the wallet on first call when AGENT_WALLET_ID is unset", async () => {
    const spies = installMockClient();
    const acct = await getOrCreateAgentAccount();
    expect(spies.createWalletAccount).toHaveBeenCalledTimes(1);
    expect(spies.getWalletAccount).not.toHaveBeenCalled();
    expect(acct).toEqual(ACCT);
  });

  it("fetches (not creates) the wallet when AGENT_WALLET_ID is set", async () => {
    process.env.AGENT_WALLET_ID = "wallet-existing-9";
    const spies = installMockClient();
    const acct = await getOrCreateAgentAccount();
    expect(spies.getWalletAccount).toHaveBeenCalledTimes(1);
    expect(spies.getWalletAccount).toHaveBeenCalledWith({ walletId: "wallet-existing-9", password: "pw-xyz" });
    expect(spies.createWalletAccount).not.toHaveBeenCalled();
    expect(acct).toEqual(EXISTING);
  });

  it("returns the same account object on repeated calls (no re-create)", async () => {
    const spies = installMockClient();
    const a = await getOrCreateAgentAccount();
    const b = await getOrCreateAgentAccount();
    expect(a).toBe(b);
    expect(spies.createWalletAccount).toHaveBeenCalledTimes(1);
  });

  it("agentAddress returns the MPC wallet address", async () => {
    installMockClient();
    await expect(agentAddress()).resolves.toBe(ACCT.accountAddress);
  });
});
