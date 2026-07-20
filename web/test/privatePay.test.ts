import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@unlink-xyz/sdk", () => ({}));

import {
  payMerchantPrivately,
  DEFAULT_SHIELD_MULTIPLE,
  ShieldFailedError,
  WithdrawFailedError,
  UnlinkSdkUnavailableError,
  type PrivatePayDeps,
} from "../lib/unlink/privatePay.js";

const MERCHANT = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const USER_ID = "dyn|sub-agent";

/** Turn the rail fully ON (flag + the two required Unlink env values). */
function configureOn(): void {
  process.env.UNLINK_PRIVATE_PAY = "true";
  process.env.UNLINK_API_KEY = "sk_test_secret_should_never_leak";
  process.env.ARC_TESTNET_USDC = "0x0000000000000000000000000000000000000abc";
}

function clearConfig(): void {
  delete process.env.UNLINK_PRIVATE_PAY;
  delete process.env.NEXT_PUBLIC_EARNINGS_PRIVACY;
  delete process.env.UNLINK_API_KEY;
  delete process.env.ARC_TESTNET_USDC;
}

/** Build injectable deps that record call order into `calls`. */
function makeDeps(
  calls: string[],
  opts?: { shieldThrows?: unknown; registerThrows?: unknown },
): PrivatePayDeps {
  return {
    ensureRegistered: vi.fn(async (_userId: string) => {
      calls.push("ensureRegistered");
      if (opts?.registerThrows) throw opts.registerThrows;
    }),
    getClient: vi.fn(async () => {
      calls.push("getClient");
      return {} as any;
    }),
    shieldAndWithdraw: vi.fn(async (params) => {
      calls.push("shieldAndWithdraw");
      if (opts?.shieldThrows) throw opts.shieldThrows;
      return { depositTx: "0xdeposit", withdrawTx: "0xpayment", __params: params } as never;
    }),
  };
}

describe("payMerchantPrivately", () => {
  beforeEach(() => clearConfig());
  afterEach(() => clearConfig());

  it("happy path: shields more than it pays, registers BEFORE shielding, returns paid + txs", async () => {
    configureOn();
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const outcome = await payMerchantPrivately(
      { userId: USER_ID, merchant: MERCHANT, amountUsd: 4.2 },
      deps,
    );
    expect(outcome).toEqual({ status: "paid", depositTx: "0xdeposit", paymentTx: "0xpayment" });
    // Registration runs before the shield (call-order keystone).
    expect(calls).toEqual(["ensureRegistered", "getClient", "shieldAndWithdraw"]);
    // Asymmetry keystone: deposit (4.2 * 4x) strictly larger than the withdraw (4.2).
    expect(deps.shieldAndWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        depositAmountUsdc: 4_200_000 * DEFAULT_SHIELD_MULTIPLE,
        withdrawAmountUsdc: 4_200_000,
        destination: MERCHANT,
      }),
    );
  });

  it("flag-off (default): returns not_configured/flag_off and NEVER calls the SDK", async () => {
    // No UNLINK_PRIVATE_PAY set at all → default public path.
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const outcome = await payMerchantPrivately(
      { userId: USER_ID, merchant: MERCHANT, amountUsd: 4.2 },
      deps,
    );
    expect(outcome).toEqual({ status: "not_configured", reason: "flag_off" });
    expect(calls).toEqual([]);
    expect(deps.ensureRegistered).not.toHaveBeenCalled();
    expect(deps.shieldAndWithdraw).not.toHaveBeenCalled();
  });

  it("flag on but Unlink env missing: returns not_configured (no SDK call, no throw)", async () => {
    process.env.UNLINK_PRIVATE_PAY = "true"; // flag on, but API key + USDC absent
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const outcome = await payMerchantPrivately(
      { userId: USER_ID, merchant: MERCHANT, amountUsd: 4.2 },
      deps,
    );
    expect(outcome).toEqual({ status: "not_configured", reason: "not_configured" });
    expect(calls).toEqual([]);
  });

  it("SDK absent during register: returns unlink_sdk_unavailable (recoverable), never throws", async () => {
    configureOn();
    const calls: string[] = [];
    const deps = makeDeps(calls, { registerThrows: new UnlinkSdkUnavailableError() });
    const outcome = await payMerchantPrivately(
      { userId: USER_ID, merchant: MERCHANT, amountUsd: 4.2 },
      deps,
    );
    expect(outcome).toEqual({ status: "unlink_sdk_unavailable", recoverable: true });
    expect(deps.shieldAndWithdraw).not.toHaveBeenCalled();
  });

  it("SDK absent during shield: returns unlink_sdk_unavailable (recoverable), never throws", async () => {
    configureOn();
    const calls: string[] = [];
    const deps = makeDeps(calls, { shieldThrows: new UnlinkSdkUnavailableError() });
    const outcome = await payMerchantPrivately(
      { userId: USER_ID, merchant: MERCHANT, amountUsd: 4.2 },
      deps,
    );
    expect(outcome).toEqual({ status: "unlink_sdk_unavailable", recoverable: true });
  });

  it("shield failure surfaces ShieldFailedError unchanged (law #5 — never swallowed)", async () => {
    configureOn();
    const calls: string[] = [];
    const deps = makeDeps(calls, { shieldThrows: new ShieldFailedError() });
    await expect(
      payMerchantPrivately({ userId: USER_ID, merchant: MERCHANT, amountUsd: 4.2 }, deps),
    ).rejects.toBeInstanceOf(ShieldFailedError);
  });

  it("withdraw failure surfaces WithdrawFailedError (recoverable, carries depositTx)", async () => {
    configureOn();
    const calls: string[] = [];
    const deps = makeDeps(calls, { shieldThrows: new WithdrawFailedError("0xdeposit") });
    let caught: unknown;
    try {
      await payMerchantPrivately({ userId: USER_ID, merchant: MERCHANT, amountUsd: 4.2 }, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WithdrawFailedError);
    expect((caught as WithdrawFailedError).recoverable).toBe(true);
    expect((caught as WithdrawFailedError).depositTx).toBe("0xdeposit");
  });

  it("rejects a non-positive amount before any SDK call (law #5: never pay zero)", async () => {
    configureOn();
    const calls: string[] = [];
    const deps = makeDeps(calls);
    await expect(
      payMerchantPrivately({ userId: USER_ID, merchant: MERCHANT, amountUsd: 0 }, deps),
    ).rejects.toThrow(/positive/);
    expect(deps.ensureRegistered).not.toHaveBeenCalled();
  });

  it("rejects shieldMultiple <= 1 (asymmetry keystone) before any SDK call", async () => {
    configureOn();
    const calls: string[] = [];
    const deps = makeDeps(calls);
    await expect(
      payMerchantPrivately(
        { userId: USER_ID, merchant: MERCHANT, amountUsd: 4.2, shieldMultiple: 1 },
        deps,
      ),
    ).rejects.toThrow(/asymmetry/);
    expect(deps.ensureRegistered).not.toHaveBeenCalled();
  });

  it("no UNLINK_API_KEY value ever appears in a returned outcome", async () => {
    configureOn();
    const deps = makeDeps([]);
    const outcome = await payMerchantPrivately(
      { userId: USER_ID, merchant: MERCHANT, amountUsd: 4.2 },
      deps,
    );
    expect(JSON.stringify(outcome)).not.toMatch(/sk_test_secret/);
  });
});
