/**
 * @file pay.auth.test.ts — caller authentication for POST /api/agent/pay (R-5).
 *
 * The route signs and spends real USDC, so an internal shared secret — NOT the budget cap or
 * the SSRF allowlist — is the security boundary. These pin that gate:
 *   - secret UNSET + no escape hatch  → FAIL CLOSED with 503 not_configured (no spend),
 *   - secret SET + missing header     → 401 (no spend),
 *   - secret SET + wrong header       → 401 (no spend),
 *   - secret SET + correct header     → proceeds (200),
 *   - the escape hatch (AGENT_ALLOW_INSECURE=true) lets a no-secret deploy through (local dev).
 *
 * Every rejection must short-circuit BEFORE the wallet or the x402 wrapper is touched: an
 * unauthenticated request never reaches the meter, the wallet, or any network effect.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../pay/route.js";
import {
  setWrapFetchWithPayment,
  setBaseFetchForTests,
} from "../../../../lib/agent/payPerCall.js";
import { __resetMeterForTests, meterSpent } from "../../../../lib/agent/agentMeter.js";
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

const SECRET = "agent-internal-secret-canary";
const ALLOWED = "http://localhost:3000/api/premium/quote";

let paidFetch: ReturnType<typeof vi.fn>;

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

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/agent/pay", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/pay — caller auth (R-5)", () => {
  beforeEach(() => {
    __resetMeterForTests();
    __resetWalletForTests();
    process.env.DYNAMIC_ENVIRONMENT_ID = "env-123";
    process.env.DYNAMIC_AUTH_TOKEN = "tok-abc";
    process.env.WALLET_PASSWORD = "pw";
    process.env.AGENT_DAILY_USD_CAP = "5.00";
    process.env.AGENT_URL_ALLOWLIST = "http://localhost:3000";
    delete process.env.AGENT_WALLET_ID;
    delete process.env.AGENT_INTERNAL_SECRET;
    delete process.env.AGENT_ALLOW_INSECURE;
    installWalletMock();
    paidFetch = vi.fn(async () => new Response(JSON.stringify({ quote: "ok" }), { status: 200 }));
    setWrapFetchWithPayment((() => paidFetch) as never);
  });

  afterEach(() => {
    setWrapFetchWithPayment(null);
    setBaseFetchForTests(null);
    setDynamicClientFactory(null);
    __resetMeterForTests();
    __resetWalletForTests();
    delete process.env.AGENT_INTERNAL_SECRET;
    delete process.env.AGENT_ALLOW_INSECURE;
  });

  it("FAILS CLOSED with 503 not_configured when no secret is set (and never spends)", async () => {
    const res = await POST(req({ url: ALLOWED }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("not_configured");
    expect(paidFetch).not.toHaveBeenCalled();
    expect(meterSpent()).toBe(0);
  });

  it("rejects a missing x-internal-secret header with 401 when the secret is set (no spend)", async () => {
    process.env.AGENT_INTERNAL_SECRET = SECRET;
    const res = await POST(req({ url: ALLOWED }));
    expect(res.status).toBe(401);
    expect(paidFetch).not.toHaveBeenCalled();
    expect(meterSpent()).toBe(0);
  });

  it("rejects a wrong x-internal-secret header with 401 (no spend)", async () => {
    process.env.AGENT_INTERNAL_SECRET = SECRET;
    const res = await POST(req({ url: ALLOWED }, { "x-internal-secret": "wrong" }));
    expect(res.status).toBe(401);
    expect(paidFetch).not.toHaveBeenCalled();
    expect(meterSpent()).toBe(0);
  });

  it("authenticates the caller before parsing the body — no header ⇒ 401 even on junk JSON", async () => {
    process.env.AGENT_INTERNAL_SECRET = SECRET;
    const bad = new Request("http://localhost:3000/api/agent/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(bad);
    // 401 (auth), NOT 400 (bad body): the gate runs first.
    expect(res.status).toBe(401);
  });

  it("proceeds to 200 with the correct x-internal-secret header", async () => {
    process.env.AGENT_INTERNAL_SECRET = SECRET;
    const res = await POST(req({ url: ALLOWED }, { "x-internal-secret": SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(paidFetch).toHaveBeenCalledTimes(1);
  });

  it("the AGENT_ALLOW_INSECURE escape hatch lets a no-secret deploy through (local dev)", async () => {
    process.env.AGENT_ALLOW_INSECURE = "true";
    const res = await POST(req({ url: ALLOWED }));
    expect(res.status).toBe(200);
    expect(paidFetch).toHaveBeenCalledTimes(1);
  });

  it("never leaks the secret in a refusal body", async () => {
    process.env.AGENT_INTERNAL_SECRET = SECRET;
    const res = await POST(req({ url: ALLOWED }, { "x-internal-secret": "wrong" }));
    const text = await res.text();
    expect(text).not.toContain(SECRET);
  });
});
