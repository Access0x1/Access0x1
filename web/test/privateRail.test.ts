import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@unlink-xyz/sdk", () => ({}));

import {
  attemptPrivateRail,
  PrivatePayFailed,
  type PrivateRailRequest,
} from "../app/api/agent/pay/privateRail.js";
import { type PrivatePayDeps } from "../lib/unlink/privatePay.js";
import { ShieldFailedError, WithdrawFailedError } from "../lib/unlink/privateWithdraw.js";

const MERCHANT = "0x3333333333333333333333333333333333333333";

function clear(): void {
  delete process.env.UNLINK_PRIVATE_PAY;
  delete process.env.UNLINK_API_KEY;
  delete process.env.ARC_TESTNET_USDC;
  delete process.env.UNLINK_PAYOUT_USER_ID;
}

function configureOn(): void {
  process.env.UNLINK_PRIVATE_PAY = "true";
  process.env.UNLINK_API_KEY = "sk_test_secret_should_never_leak";
  process.env.ARC_TESTNET_USDC = "0x0000000000000000000000000000000000000abc";
  process.env.UNLINK_PAYOUT_USER_ID = "dyn|sub-agent";
}

function makeDeps(opts?: { shieldThrows?: unknown }): PrivatePayDeps {
  return {
    ensureRegistered: vi.fn(async () => undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getClient: vi.fn(async () => ({}) as any),
    shieldAndWithdraw: vi.fn(async () => {
      if (opts?.shieldThrows) throw opts.shieldThrows;
      return { depositTx: "0xdeposit", withdrawTx: "0xpayment" };
    }),
  };
}

const REQ: PrivateRailRequest = { merchant: MERCHANT, amountUsd: 0.001 };

describe("attemptPrivateRail", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("flag OFF (default): falls back to the public path without touching deps", async () => {
    const deps = makeDeps();
    const result = await attemptPrivateRail(REQ, deps);
    expect(result).toEqual({ handled: false, fallback: true });
    expect(deps.ensureRegistered).not.toHaveBeenCalled();
    expect(deps.shieldAndWithdraw).not.toHaveBeenCalled();
  });

  it("flag ON + configured: handles the payment and returns depositTx/paymentTx", async () => {
    configureOn();
    const deps = makeDeps();
    const result = await attemptPrivateRail(REQ, deps);
    expect(result).toEqual({ handled: true, depositTx: "0xdeposit", paymentTx: "0xpayment" });
    expect(deps.shieldAndWithdraw).toHaveBeenCalledOnce();
  });

  it("flag ON but Unlink env missing: not_configured => fall back (no throw)", async () => {
    process.env.UNLINK_PRIVATE_PAY = "true";
    process.env.UNLINK_PAYOUT_USER_ID = "dyn|sub-agent"; // flag on, but no API key / USDC
    const deps = makeDeps();
    const result = await attemptPrivateRail(REQ, deps);
    expect(result).toEqual({ handled: false, fallback: true });
    expect(deps.shieldAndWithdraw).not.toHaveBeenCalled();
  });

  it("flag ON but no bound userId: falls back (rail not configured)", async () => {
    process.env.UNLINK_PRIVATE_PAY = "true";
    process.env.UNLINK_API_KEY = "sk_test";
    process.env.ARC_TESTNET_USDC = "0x0000000000000000000000000000000000000abc";
    const deps = makeDeps();
    const result = await attemptPrivateRail(REQ, deps);
    expect(result).toEqual({ handled: false, fallback: true });
  });

  it("flag ON but no/invalid merchant: 400 badRequest (NOT a silent fallback)", async () => {
    configureOn();
    const deps = makeDeps();
    const noMerchant = await attemptPrivateRail({ amountUsd: 0.001 }, deps);
    expect(noMerchant).toMatchObject({ handled: false, badRequest: expect.stringMatching(/0x/) });
    const badMerchant = await attemptPrivateRail({ merchant: "not-an-address", amountUsd: 0.001 }, deps);
    expect(badMerchant).toMatchObject({ handled: false, badRequest: expect.any(String) });
  });

  it("shield failure maps to PrivatePayFailed(shield_failed) (law #5)", async () => {
    configureOn();
    const deps = makeDeps({ shieldThrows: new ShieldFailedError() });
    await expect(attemptPrivateRail(REQ, deps)).rejects.toBeInstanceOf(PrivatePayFailed);
    await attemptPrivateRail(REQ, deps).catch((e: PrivatePayFailed) => {
      expect(e.code).toBe("shield_failed");
    });
  });

  it("withdraw failure maps to PrivatePayFailed(withdraw_failed, recoverable)", async () => {
    configureOn();
    const deps = makeDeps({ shieldThrows: new WithdrawFailedError("0xdeposit") });
    let caught: unknown;
    try {
      await attemptPrivateRail(REQ, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrivatePayFailed);
    expect((caught as PrivatePayFailed).code).toBe("withdraw_failed");
    expect((caught as PrivatePayFailed).recoverable).toBe(true);
  });
});
