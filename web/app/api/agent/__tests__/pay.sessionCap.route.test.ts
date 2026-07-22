/**
 * @file pay.sessionCap.route.test.ts — POST /api/agent/pay execution-rights policy.
 *
 * Verifies the World-AgentKit admission policy wired at the TOP of the route:
 *  - DORMANT when off (AGENT_SESSION_CAP_ENFORCED unset): a spend that WOULD exceed a
 *    session cap still succeeds → behavior IDENTICAL to today,
 *  - enforced + UNVERIFIED agent over the conservative cap → 402 SessionBudgetCapExceeded,
 *  - enforced + HUMAN-BACKED agent: the SAME request is allowed under the elevated cap
 *    (differentiated execution terms),
 *  - the elevated cap is itself enforced + env-tunable,
 *  - enforced + under the cap → the request proceeds unchanged.
 * The wallet + payment layers are mocked exactly as pay.route.test.ts; the policy is
 * exercised via the env flag + the process admission state (unlockAgentTrial).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../pay/route.js";
import {
  setWrapFetchWithPayment,
  setBaseFetchForTests,
} from "../../../../lib/agent/payPerCall.js";
import { __resetMeterForTests } from "../../../../lib/agent/agentMeter.js";
import {
  setDynamicClientFactory,
  __resetWalletForTests,
  type DynamicEvmWalletClient,
  type AgentAccount,
} from "../../../../lib/agent/dynamicAgentWallet.js";
import {
  unlockAgentTrial,
  __resetAgentTrialForTests,
} from "../../../../lib/worldid/agentGate.js";

const ACCT: AgentAccount = {
  accountAddress: "0xAGENT0000000000000000000000000000000abc",
  publicKeyHex: "0xpub",
  walletId: "wallet-1",
};

const ALLOWED = "http://localhost:3000/api/premium/quote";

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

function req(body: unknown): Request {
  return new Request("http://localhost:3000/api/agent/pay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/pay — execution-rights session cap", () => {
  beforeEach(() => {
    __resetMeterForTests();
    __resetWalletForTests();
    __resetAgentTrialForTests();
    process.env.DYNAMIC_ENVIRONMENT_ID = "env-123";
    process.env.DYNAMIC_AUTH_TOKEN = "tok-abc";
    process.env.WALLET_PASSWORD = "pw";
    process.env.AGENT_DAILY_USD_CAP = "5.00";
    process.env.AGENT_URL_ALLOWLIST = "http://localhost:3000";
    // Exercise the session-cap policy, NOT the R-5 caller-auth gate: open it via the
    // explicit local-dev escape hatch (the route fails CLOSED without it).
    process.env.AGENT_ALLOW_INSECURE = "true";
    delete process.env.AGENT_INTERNAL_SECRET;
    delete process.env.AGENT_WALLET_ID;
    // Keep the human-required gate OUT of these tests (it would 402 before the cap).
    delete process.env.AGENT_REQUIRE_HUMAN;
    delete process.env.AGENT_SESSION_CAP_ENFORCED;
    delete process.env.AGENT_SESSION_CAP_HUMAN_USD;
    delete process.env.AGENT_SESSION_CAP_DEFAULT_USD;
    installWalletMock();
    setWrapFetchWithPayment((() => async () => jsonResponse({ quote: "ok" })) as never);
  });

  afterEach(() => {
    setWrapFetchWithPayment(null);
    setBaseFetchForTests(null);
    setDynamicClientFactory(null);
    __resetMeterForTests();
    __resetWalletForTests();
    __resetAgentTrialForTests();
    delete process.env.AGENT_ALLOW_INSECURE;
    delete process.env.AGENT_INTERNAL_SECRET;
    delete process.env.AGENT_SESSION_CAP_ENFORCED;
    delete process.env.AGENT_SESSION_CAP_HUMAN_USD;
    delete process.env.AGENT_SESSION_CAP_DEFAULT_USD;
  });

  it("DORMANT when off: a spend over the conservative cap still succeeds (identical to today)", async () => {
    // 0.5 × 2 = 1.0 would exceed the 0.50 default cap IF enforced — but the flag is off.
    const res = await POST(req({ url: ALLOWED, count: 2, pricePerCallUsd: 0.5 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(2);
  });

  it("enforced + unverified agent over the conservative cap → 402 SessionBudgetCapExceeded", async () => {
    process.env.AGENT_SESSION_CAP_ENFORCED = "true";
    // Agent NOT unlocked → unverified tier → default 0.50 cap; 0.5 × 2 = 1.0 > 0.50.
    const res = await POST(req({ url: ALLOWED, count: 2, pricePerCallUsd: 0.5 }));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("SessionBudgetCapExceeded");
    expect(body.tier).toBe("unverified");
    expect(body.cap).toBe(0.5);
    expect(body.requested).toBe(1);
  });

  it("enforced + human-backed agent: the SAME request is allowed under the elevated cap", async () => {
    process.env.AGENT_SESSION_CAP_ENFORCED = "true";
    unlockAgentTrial(); // agent proven human-backed this process
    const res = await POST(req({ url: ALLOWED, count: 2, pricePerCallUsd: 0.5 }));
    // 1.0 <= elevated 5.00 cap AND <= 5.00 daily meter → proceeds.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(2);
  });

  it("enforced + human-backed but over the (env-tuned) elevated cap → 402", async () => {
    process.env.AGENT_SESSION_CAP_ENFORCED = "true";
    process.env.AGENT_SESSION_CAP_HUMAN_USD = "0.30";
    unlockAgentTrial();
    const res = await POST(req({ url: ALLOWED, count: 2, pricePerCallUsd: 0.5 })); // 1.0 > 0.30
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("SessionBudgetCapExceeded");
    expect(body.tier).toBe("human-backed");
    expect(body.cap).toBe(0.3);
  });

  it("enforced + unverified but under the (env-tuned) conservative cap → 200", async () => {
    process.env.AGENT_SESSION_CAP_ENFORCED = "true";
    process.env.AGENT_SESSION_CAP_DEFAULT_USD = "1.00";
    const res = await POST(req({ url: ALLOWED, count: 1, pricePerCallUsd: 0.5 })); // 0.5 <= 1.00
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ quote: "ok" });
  });
});
