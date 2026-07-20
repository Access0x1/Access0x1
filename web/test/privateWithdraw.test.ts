import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@unlink-xyz/sdk", () => ({}));

import {
  shieldAndWithdraw,
  privateTransfer,
  WithdrawFailedError,
  ShieldFailedError,
} from "../lib/unlink/privateWithdraw.js";

const DEST = "0x2222222222222222222222222222222222222222" as `0x${string}`;

/** Build a mock UnlinkClient that records call order into `calls`. */
function makeClient(calls: string[], opts?: { withdrawFails?: boolean; depositFails?: boolean }) {
  return {
    depositWithApproval: vi.fn(async () => {
      calls.push("depositWithApproval");
      if (opts?.depositFails) throw new Error("rpc rejected deposit");
      return { txHash: "0xdeposit" as `0x${string}` };
    }),
    waitForTx: vi.fn(async (h: `0x${string}`) => {
      calls.push("waitForTx");
      return { txHash: h };
    }),
    withdraw: vi.fn(async () => {
      calls.push("withdraw");
      if (opts?.withdrawFails) throw new Error("relayer rejected withdraw");
      return { txHash: "0xwithdraw" as `0x${string}` };
    }),
    transfer: vi.fn(async () => {
      calls.push("transfer");
      return { txHash: "0xtransfer" as `0x${string}` };
    }),
  } as any;
}

describe("shieldAndWithdraw", () => {
  beforeEach(() => {
    process.env.ARC_TESTNET_USDC = "0x0000000000000000000000000000000000000abc";
  });

  it("calls depositWithApproval BEFORE waitForTx BEFORE withdraw", async () => {
    const calls: string[] = [];
    const client = makeClient(calls);
    await shieldAndWithdraw({
      client,
      depositAmountUsdc: 50_000_000,
      withdrawAmountUsdc: 4_200_000,
      destination: DEST,
    });
    expect(calls).toEqual(["depositWithApproval", "waitForTx", "withdraw"]);
  });

  it("returns both tx hashes on the happy path", async () => {
    const client = makeClient([]);
    const res = await shieldAndWithdraw({
      client,
      depositAmountUsdc: 50_000_000,
      withdrawAmountUsdc: 4_200_000,
      destination: DEST,
    });
    expect(res).toEqual({ depositTx: "0xdeposit", withdrawTx: "0xwithdraw" });
  });

  it("asymmetry guard: depositAmount <= withdrawAmount throws BEFORE any SDK call", async () => {
    const calls: string[] = [];
    const client = makeClient(calls);
    await expect(
      shieldAndWithdraw({
        client,
        depositAmountUsdc: 4_200_000,
        withdrawAmountUsdc: 4_200_000,
        destination: DEST,
      }),
    ).rejects.toThrow(/asymmetry/);
    expect(calls).toEqual([]);
    expect(client.depositWithApproval).not.toHaveBeenCalled();
  });

  it("rejects a non-positive withdraw amount before any SDK call", async () => {
    const calls: string[] = [];
    const client = makeClient(calls);
    await expect(
      shieldAndWithdraw({ client, depositAmountUsdc: 10, withdrawAmountUsdc: 0, destination: DEST }),
    ).rejects.toThrow(/> 0/);
    expect(calls).toEqual([]);
  });

  it("shield failure throws ShieldFailedError (no funds shielded) and never calls withdraw", async () => {
    const calls: string[] = [];
    const client = makeClient(calls, { depositFails: true });
    await expect(
      shieldAndWithdraw({
        client,
        depositAmountUsdc: 50_000_000,
        withdrawAmountUsdc: 4_200_000,
        destination: DEST,
      }),
    ).rejects.toBeInstanceOf(ShieldFailedError);
    expect(client.withdraw).not.toHaveBeenCalled();
  });

  it("withdraw-fail after shield is recoverable (law #5): carries recoverable:true + depositTx", async () => {
    const client = makeClient([], { withdrawFails: true });
    let caught: unknown;
    try {
      await shieldAndWithdraw({
        client,
        depositAmountUsdc: 50_000_000,
        withdrawAmountUsdc: 4_200_000,
        destination: DEST,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WithdrawFailedError);
    const err = caught as WithdrawFailedError;
    expect(err.recoverable).toBe(true);
    expect(err.code).toBe("withdraw_failed");
    expect(err.depositTx).toBe("0xdeposit");
    // The shield DID land — we do not pretend it didn't (no swallow).
    expect(client.depositWithApproval).toHaveBeenCalled();
  });

  it("throws when ARC_TESTNET_USDC is unconfigured", async () => {
    delete process.env.ARC_TESTNET_USDC;
    const client = makeClient([]);
    await expect(
      shieldAndWithdraw({
        client,
        depositAmountUsdc: 50_000_000,
        withdrawAmountUsdc: 4_200_000,
        destination: DEST,
      }),
    ).rejects.toThrow(/ARC_TESTNET_USDC/);
  });
});

describe("privateTransfer", () => {
  it("rejects a toUnlinkAddress that does not start with unlink1", async () => {
    const client = makeClient([]);
    await expect(
      privateTransfer({ client, amountUsdc: 1_000_000, toUnlinkAddress: "0xabc" }),
    ).rejects.toThrow(/unlink1/);
    expect(client.transfer).not.toHaveBeenCalled();
  });

  it("accepts an unlink1 address and returns the transfer tx hash", async () => {
    const client = makeClient([]);
    const tx = await privateTransfer({
      client,
      amountUsdc: 1_000_000,
      toUnlinkAddress: "unlink1qxyz",
    });
    expect(tx).toBe("0xtransfer");
    expect(client.transfer).toHaveBeenCalledWith({ amount: 1_000_000n, to: "unlink1qxyz" });
  });

  it("rejects a non-positive amount", async () => {
    const client = makeClient([]);
    await expect(
      privateTransfer({ client, amountUsdc: 0, toUnlinkAddress: "unlink1qxyz" }),
    ).rejects.toThrow(/> 0/);
  });
});
