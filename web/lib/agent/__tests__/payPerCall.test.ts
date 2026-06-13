/**
 * @file payPerCall.test.ts — CEI ordering, refund law #5, nano-loop, amount math (RED-first).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  agentPay,
  agentNanoLoop,
  usdToUsdcUnits,
  PaymentRequiredUnresolved,
  UpstreamError,
  setWrapFetchWithPayment,
  setBaseFetchForTests,
  type FetchLike,
} from "../payPerCall.js";
import { __resetMeterForTests, meterSpent } from "../agentMeter.js";
import {
  setDynamicClientFactory,
  __resetWalletForTests,
  type DynamicEvmWalletClient,
  type AgentAccount,
} from "../dynamicAgentWallet.js";

const ACCT: AgentAccount = {
  accountAddress: "0xAGENT0000000000000000000000000000000abc",
  publicKeyHex: "0xpub",
  walletId: "wallet-1",
};

function installWalletMock(): void {
  const client: DynamicEvmWalletClient = {
    authenticateApiToken: vi.fn().mockResolvedValue(undefined),
    createWalletAccount: vi.fn().mockResolvedValue(ACCT),
    getWalletAccount: vi.fn().mockResolvedValue(ACCT),
    signTypedData: vi.fn().mockResolvedValue("0xsig"),
    signMessage: vi.fn().mockResolvedValue("0xsig"),
  };
  setDynamicClientFactory((() => client) as never);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("payPerCall", () => {
  beforeEach(() => {
    __resetMeterForTests();
    __resetWalletForTests();
    process.env.DYNAMIC_ENVIRONMENT_ID = "env-123";
    process.env.DYNAMIC_AUTH_TOKEN = "tok-abc";
    process.env.WALLET_PASSWORD = "pw";
    process.env.AGENT_DAILY_USD_CAP = "5.00";
    delete process.env.AGENT_WALLET_ID;
    installWalletMock();
  });

  afterEach(() => {
    setWrapFetchWithPayment(null);
    setBaseFetchForTests(null);
    setDynamicClientFactory(null);
    __resetMeterForTests();
    __resetWalletForTests();
  });

  it("charges the meter BEFORE invoking the x402 wrapper (CEI order)", async () => {
    const order: string[] = [];
    process.env.AGENT_DAILY_USD_CAP = "0"; // force the meter check to throw first
    const wrap = vi.fn((base: FetchLike) => {
      order.push("wrap");
      return base;
    });
    setWrapFetchWithPayment(wrap as never);
    await expect(agentPay({ url: "https://x/quote", maxValueUsd: 0.01 })).rejects.toMatchObject({
      name: "BudgetExceeded",
    });
    // wrapFetchWithPayment must NEVER run when the meter rejects.
    expect(wrap).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("makes zero network calls when BudgetExceeded", async () => {
    process.env.AGENT_DAILY_USD_CAP = "0";
    const paid = vi.fn(async () => jsonResponse({ quote: 1 }));
    setWrapFetchWithPayment((() => paid) as never);
    await expect(agentPay({ url: "https://x/quote", maxValueUsd: 0.01 })).rejects.toMatchObject({
      name: "BudgetExceeded",
    });
    expect(paid).not.toHaveBeenCalled();
  });

  it("returns parsed JSON on success and does not refund", async () => {
    setWrapFetchWithPayment((() => async () => jsonResponse({ quote: 42 })) as never);
    const result = await agentPay({ url: "https://x/quote", maxValueUsd: 0.01 });
    expect(result).toEqual({ quote: 42 });
    expect(meterSpent()).toBe(0.01);
  });

  it("on persistent 402: throws PaymentRequiredUnresolved AND refunds (law #5)", async () => {
    setWrapFetchWithPayment((() => async () => jsonResponse({ error: "x402" }, 402)) as never);
    await expect(agentPay({ url: "https://x/quote", maxValueUsd: 0.03 })).rejects.toBeInstanceOf(
      PaymentRequiredUnresolved,
    );
    expect(meterSpent()).toBe(0); // refunded
  });

  it("on upstream 500: throws UpstreamError and does NOT refund (fee consumed)", async () => {
    setWrapFetchWithPayment((() => async () => jsonResponse({ error: "boom" }, 500)) as never);
    await expect(agentPay({ url: "https://x/quote", maxValueUsd: 0.02 })).rejects.toBeInstanceOf(UpstreamError);
    expect(meterSpent()).toBe(0.02); // NOT refunded
  });

  it("refunds on a thrown network error before settlement", async () => {
    setWrapFetchWithPayment((() => async () => {
      throw new Error("ECONNRESET");
    }) as never);
    await expect(agentPay({ url: "https://x/quote", maxValueUsd: 0.02 })).rejects.toThrow(/ECONNRESET/);
    expect(meterSpent()).toBe(0); // refunded
  });

  it("agentNanoLoop fires agentPay exactly count times and returns count results", async () => {
    let calls = 0;
    setWrapFetchWithPayment((() => async () => {
      calls += 1;
      return jsonResponse({ n: calls });
    }) as never);
    const results = await agentNanoLoop({ url: "https://x/quote", count: 20, pricePerCallUsd: 0.001 });
    expect(results).toHaveLength(20);
    expect(calls).toBe(20);
    expect(meterSpent()).toBeCloseTo(0.02, 10);
  });

  it("agentNanoLoop rejects a non-positive-integer count", async () => {
    await expect(agentNanoLoop({ url: "https://x/q", count: 0, pricePerCallUsd: 0.001 })).rejects.toThrowError(
      RangeError,
    );
  });

  it("amount math: Math.round(price * 1e6) is exact for the demo range", () => {
    expect(usdToUsdcUnits(0.001)).toBe(1000);
    expect(usdToUsdcUnits(0.01)).toBe(10000);
    expect(usdToUsdcUnits(0.03)).toBe(30000);
  });
});
