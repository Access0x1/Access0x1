/**
 * @file pay.ssrf.test.ts — adversarial SSRF allowlist coverage for POST /api/agent/pay.
 *
 * The agent will sign and spend real USDC against whatever URL it is handed, so the
 * allowlist is the only thing standing between it and an attacker-chosen endpoint
 * (cloud metadata, loopback admin ports, file/data exfil). These tests pin that:
 *   - cloud-metadata (IMDS 169.254.169.254) is rejected unless explicitly allowlisted,
 *   - non-http schemes (file:, data:) are rejected (their URL origin is "null"),
 *   - a credentials-in-URL trick (http://allowed@evil) is rejected — the REAL origin
 *     is evil, and the allowlist matches on origin,
 *   - a look-alike host (allowed.evil.com) is rejected,
 *   - and when a url IS allowlisted no payment is attempted for a non-allowlisted one
 *     (the meter/network is never touched on a rejected url).
 *
 * The wallet + x402 wrapper are mocked; a rejected url must short-circuit BEFORE either
 * is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function req(body: unknown): Request {
  return new Request("http://localhost:3000/api/agent/pay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/pay — SSRF allowlist (adversarial)", () => {
  let paidFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetMeterForTests();
    __resetWalletForTests();
    process.env.DYNAMIC_ENVIRONMENT_ID = "env-123";
    process.env.DYNAMIC_AUTH_TOKEN = "tok-abc";
    process.env.WALLET_PASSWORD = "pw";
    process.env.AGENT_DAILY_USD_CAP = "5.00";
    // Only this exact origin is allowed.
    process.env.AGENT_URL_ALLOWLIST = "https://api.example.com";
    // These tests exercise the SSRF allowlist, NOT the R-5 caller-auth gate; open it via the
    // explicit local-dev escape hatch (the route fails CLOSED without it).
    process.env.AGENT_ALLOW_INSECURE = "true";
    delete process.env.AGENT_INTERNAL_SECRET;
    delete process.env.AGENT_WALLET_ID;
    installWalletMock();
    paidFetch = vi.fn(async () =>
      new Response(JSON.stringify({ quote: "ok" }), { status: 200 }),
    );
    setWrapFetchWithPayment((() => paidFetch) as never);
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

  /** Every one of these must be rejected with 400 and spend nothing. */
  const blocked: Array<[string, string]> = [
    ["cloud-metadata IMDS", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["loopback admin port", "http://127.0.0.1:6379/"],
    ["ipv6 loopback", "http://[::1]:8545/"],
    ["file scheme exfil", "file:///etc/passwd"],
    ["data scheme", "data:text/plain,hello"],
    ["credentials-in-url to evil host", "https://api.example.com@evil.example.com/x"],
    ["look-alike host", "https://api.example.com.evil.example.com/x"],
    ["wrong scheme (http vs allowed https)", "http://api.example.com/x"],
    ["wrong port", "https://api.example.com:8443/x"],
    ["plain garbage", "not-a-url"],
  ];

  for (const [label, url] of blocked) {
    it(`rejects ${label} with 400 and spends nothing`, async () => {
      const res = await POST(req({ url }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("BadRequest");
      // The wallet/x402 wrapper must never be invoked for a rejected url.
      expect(paidFetch).not.toHaveBeenCalled();
      expect(meterSpent()).toBe(0);
    });
  }

  it("allows the exact allowlisted origin (control: the guard is not deny-everything)", async () => {
    const res = await POST(req({ url: "https://api.example.com/premium/quote" }));
    expect(res.status).toBe(200);
    expect(paidFetch).toHaveBeenCalledTimes(1);
  });

  it("origin match ignores path/query/fragment (same origin, different path is allowed)", async () => {
    const res = await POST(
      req({ url: "https://api.example.com/a/b?x=1#frag" }),
    );
    expect(res.status).toBe(200);
  });
});
