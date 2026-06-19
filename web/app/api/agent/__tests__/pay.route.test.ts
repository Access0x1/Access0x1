/**
 * @file pay.route.test.ts — POST /api/agent/pay: allowlist, caps, structured errors, no leak.
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

const ACCT: AgentAccount = {
  accountAddress: "0xAGENT0000000000000000000000000000000abc",
  publicKeyHex: "0xpub",
  walletId: "wallet-1",
};

const SECRET = "wallet-password-leak-canary";

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

const ALLOWED = "http://localhost:3000/api/premium/quote";

describe("POST /api/agent/pay", () => {
  beforeEach(() => {
    __resetMeterForTests();
    __resetWalletForTests();
    process.env.DYNAMIC_ENVIRONMENT_ID = "env-123";
    process.env.DYNAMIC_AUTH_TOKEN = "tok-abc";
    process.env.WALLET_PASSWORD = SECRET;
    process.env.AGENT_DAILY_USD_CAP = "5.00";
    process.env.AGENT_URL_ALLOWLIST = "http://localhost:3000";
    // These tests exercise the allowlist / caps / error mapping, NOT the R-5 caller-auth gate.
    // Open the gate via the explicit local-dev escape hatch (the route fails CLOSED without it).
    process.env.AGENT_ALLOW_INSECURE = "true";
    delete process.env.AGENT_INTERNAL_SECRET;
    delete process.env.AGENT_WALLET_ID;
    installWalletMock();
    setWrapFetchWithPayment((() => async () => jsonResponse({ quote: "ok" })) as never);
  });

  afterEach(() => {
    setWrapFetchWithPayment(null);
    setBaseFetchForTests(null);
    setDynamicClientFactory(null);
    __resetMeterForTests();
    __resetWalletForTests();
    delete process.env.AGENT_ALLOW_INSECURE;
    delete process.env.AGENT_INTERNAL_SECRET;
  });

  it("rejects a url not in the allowlist with 400 (SSRF guard)", async () => {
    const res = await POST(req({ url: "http://evil.example.com/x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("BadRequest");
  });

  it("rejects count > 50 with 400", async () => {
    const res = await POST(req({ url: ALLOWED, count: 51 }));
    expect(res.status).toBe(400);
  });

  it("rejects a missing url with 400", async () => {
    const res = await POST(req({ count: 2 }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const badReq = new Request("http://localhost:3000/api/agent/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });

  it("happy path single call returns 200 { ok, result, agent }", async () => {
    const res = await POST(req({ url: ALLOWED }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ quote: "ok" });
    expect(body.agent).toBe(ACCT.accountAddress);
  });

  it("happy path nano-loop returns 200 { ok, results: [...] }", async () => {
    const res = await POST(req({ url: ALLOWED, count: 5, pricePerCallUsd: 0.001 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(5);
  });

  it("maps BudgetExceeded to 402 { error, spent, cap }", async () => {
    process.env.AGENT_DAILY_USD_CAP = "0.001";
    const res = await POST(req({ url: ALLOWED, count: 5, pricePerCallUsd: 0.001 }));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("BudgetExceeded");
    expect(typeof body.spent).toBe("number");
    expect(typeof body.cap).toBe("number");
  });

  it("maps PaymentRequiredUnresolved to 502", async () => {
    setWrapFetchWithPayment((() => async () => jsonResponse({ x: 402 }, 402)) as never);
    const res = await POST(req({ url: ALLOWED }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("PaymentRequiredUnresolved");
  });

  it("maps an unexpected throw to 500 { error: 'Internal' } with no secret/stack leak", async () => {
    setWrapFetchWithPayment((() => async () => {
      throw new Error(`boom secret=${SECRET}`);
    }) as never);
    const res = await POST(req({ url: ALLOWED }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "Internal" }));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("boom");
  });

  it("denies all when AGENT_URL_ALLOWLIST is unset", async () => {
    delete process.env.AGENT_URL_ALLOWLIST;
    const res = await POST(req({ url: ALLOWED }));
    expect(res.status).toBe(400);
  });
});
