import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the SDK admin + client factories (vi.hoisted so the mock factory,
//    which is hoisted to the top of the file, can reference these safely) ────────
const { register, createUnlinkAdmin, createUnlinkClient } = vi.hoisted(() => {
  const register = vi.fn(async (_params: { userId: string }) => undefined);
  const createUnlinkAdmin = vi.fn((_params: { environment: string; apiKey: string }) => ({
    users: { register },
  }));
  const createUnlinkClient = vi.fn((params: unknown) => ({ __client: params }));
  return { register, createUnlinkAdmin, createUnlinkClient };
});

vi.mock("@unlink-xyz/sdk", () => ({
  createUnlinkAdmin,
  createUnlinkClient,
}));

import { getMerchantClient, ensureRegistered } from "../lib/unlink/payoutService.js";

const ACCOUNT = { address: "0xacc0" as `0x${string}` };
const USER_ID = "dyn|sub-abc";

describe("payoutService", () => {
  beforeEach(() => {
    register.mockReset();
    register.mockResolvedValue(undefined);
    createUnlinkAdmin.mockClear();
    createUnlinkClient.mockClear();
    process.env.UNLINK_API_KEY = "sk_test_secret_should_never_leak";
    process.env.UNLINK_ENVIRONMENT = "arc-testnet";
  });
  afterEach(() => {
    delete process.env.UNLINK_API_KEY;
  });

  it("getMerchantClient passes environment/account/userId/authorizationToken to createUnlinkClient", () => {
    getMerchantClient(ACCOUNT, USER_ID, "auth-token-xyz");
    expect(createUnlinkClient).toHaveBeenCalledWith({
      environment: "arc-testnet",
      account: ACCOUNT,
      userId: USER_ID,
      authorizationToken: "auth-token-xyz",
    });
  });

  it("getMerchantClient requires a userId", () => {
    expect(() => getMerchantClient(ACCOUNT, "")).toThrow(/userId/);
  });

  it("ensureRegistered calls admin.users.register({ userId }) once", async () => {
    await ensureRegistered(USER_ID);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it("ensureRegistered does NOT throw on an already-registered error", async () => {
    register.mockRejectedValueOnce(new Error("user is already registered"));
    await expect(ensureRegistered(USER_ID)).resolves.toBeUndefined();
  });

  it("ensureRegistered re-throws other errors WITHOUT leaking the API key", async () => {
    register.mockRejectedValueOnce(new Error("network down sk_test_secret_should_never_leak"));
    let caught: unknown;
    try {
      await ensureRegistered(USER_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/failed to register/);
    // Secret must NEVER appear in the surfaced error (law: secrets never leave the box).
    expect(msg).not.toMatch(/sk_test_secret/);
  });

  it("ensureRegistered throws a clear error when UNLINK_API_KEY is missing", async () => {
    delete process.env.UNLINK_API_KEY;
    await expect(ensureRegistered(USER_ID)).rejects.toThrow(/UNLINK_API_KEY/);
    expect(register).not.toHaveBeenCalled();
  });

  it("ensureRegistered requires a userId", async () => {
    await expect(ensureRegistered("")).rejects.toThrow(/userId/);
  });
});
