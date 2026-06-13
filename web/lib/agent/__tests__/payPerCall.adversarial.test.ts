/**
 * @file payPerCall.adversarial.test.ts — budget-stop / no-double-charge edges on the
 * meter-gated x402 pay path.
 *
 * Pins the spend invariants under failure:
 *   - a nano-loop that hits the cap mid-way STOPS firing network calls at the cap
 *     (the meter short-circuits before the over-cap call) and the spend equals exactly
 *     the calls that fit — no charge for the rejected call,
 *   - a persistent-402 refund restores exactly one charge (the meter cannot go below
 *     the prior spend — no over-refund creating budget out of thin air),
 *   - an upstream 500 leaves the fee consumed (no refund) so the agent cannot retry
 *     for free after the facilitator already took the fee.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentPay,
  agentNanoLoop,
  PaymentRequiredUnresolved,
  UpstreamError,
  setWrapFetchWithPayment,
  setBaseFetchForTests,
} from "../payPerCall.js";
import { __resetMeterForTests, meterSpent, BudgetExceeded } from "../agentMeter.js";
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

describe("payPerCall — budget-stop / no-double-charge (adversarial)", () => {
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

  it("nano-loop stops AT the cap: only the calls that fit fire, the over-cap call makes no network call", async () => {
    // Cap $0.05; $0.01/call -> exactly 5 calls fit, the 6th must short-circuit.
    process.env.AGENT_DAILY_USD_CAP = "0.05";
    let networkCalls = 0;
    setWrapFetchWithPayment((() => async () => {
      networkCalls += 1;
      return jsonResponse({ n: networkCalls });
    }) as never);

    await expect(
      agentNanoLoop({ url: "https://x/quote", count: 10, pricePerCallUsd: 0.01 }),
    ).rejects.toBeInstanceOf(BudgetExceeded);

    // 5 calls fit; the 6th was rejected by the meter BEFORE any network call.
    expect(networkCalls).toBe(5);
    expect(meterSpent()).toBeCloseTo(0.05, 10);
  });

  it("persistent 402 refunds exactly one charge — the meter cannot go below prior spend", async () => {
    // First, a successful call leaves $0.02 spent.
    setWrapFetchWithPayment((() => async () => jsonResponse({ ok: 1 })) as never);
    await agentPay({ url: "https://x/quote", maxValueUsd: 0.02 });
    expect(meterSpent()).toBeCloseTo(0.02, 10);

    // Now a persistent 402 reserves then refunds $0.03 — net spend stays at $0.02.
    setWrapFetchWithPayment((() => async () => jsonResponse({ x: 402 }, 402)) as never);
    await expect(
      agentPay({ url: "https://x/quote", maxValueUsd: 0.03 }),
    ).rejects.toBeInstanceOf(PaymentRequiredUnresolved);
    expect(meterSpent()).toBeCloseTo(0.02, 10);
  });

  it("upstream 500 does NOT refund — the consumed fee is not handed back (no free retry)", async () => {
    setWrapFetchWithPayment((() => async () => jsonResponse({ boom: 1 }, 500)) as never);
    await expect(
      agentPay({ url: "https://x/quote", maxValueUsd: 0.04 }),
    ).rejects.toBeInstanceOf(UpstreamError);
    // Fee stays consumed.
    expect(meterSpent()).toBeCloseTo(0.04, 10);
  });
});
