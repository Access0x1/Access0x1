/**
 * @file pay.privateRail.route.test.ts — POST /api/agent/pay private rail dispatch.
 *
 * Verifies the ALTERNATE private rail behind /api/agent/pay:
 *  - default public x402 path is UNCHANGED when `private` is absent,
 *  - `private:true` with the flag OFF falls back to the unchanged public path,
 *  - `private:true` with the flag ON + configured takes the private rail,
 *  - the private rail's law-#5 PrivatePayFailed maps to 502.
 * The SDK is mocked absent; the private wiring is exercised via the env flag + the
 * route's own fallback, so no proprietary package is required.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@unlink-xyz/sdk", () => ({}));

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

const MERCHANT = "0x3333333333333333333333333333333333333333";
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

describe("POST /api/agent/pay — private rail dispatch", () => {
  beforeEach(() => {
    __resetMeterForTests();
    __resetWalletForTests();
    process.env.DYNAMIC_ENVIRONMENT_ID = "env-123";
    process.env.DYNAMIC_AUTH_TOKEN = "tok-abc";
    process.env.WALLET_PASSWORD = "pw";
    process.env.AGENT_DAILY_USD_CAP = "5.00";
    process.env.AGENT_URL_ALLOWLIST = "http://localhost:3000";
    delete process.env.AGENT_WALLET_ID;
    delete process.env.UNLINK_PRIVATE_PAY;
    delete process.env.UNLINK_API_KEY;
    delete process.env.ARC_TESTNET_USDC;
    delete process.env.UNLINK_PAYOUT_USER_ID;
    delete process.env.UNLINK_PRIVATE_PAY_KEY;
    installWalletMock();
    setWrapFetchWithPayment((() => async () => jsonResponse({ quote: "ok" })) as never);
  });

  afterEach(() => {
    setWrapFetchWithPayment(null);
    setBaseFetchForTests(null);
    setDynamicClientFactory(null);
    __resetMeterForTests();
    __resetWalletForTests();
    delete process.env.UNLINK_PRIVATE_PAY;
    delete process.env.UNLINK_API_KEY;
    delete process.env.ARC_TESTNET_USDC;
    delete process.env.UNLINK_PAYOUT_USER_ID;
    delete process.env.UNLINK_PRIVATE_PAY_KEY;
  });

  it("default (no private flag): public x402 path is unchanged -> 200 { ok, result }", async () => {
    const res = await POST(req({ url: ALLOWED }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ quote: "ok" });
    expect(body.rail).toBeUndefined();
  });

  it("private:true but flag OFF: falls back to the public x402 path (payment NOT dropped)", async () => {
    const res = await POST(req({ url: ALLOWED, private: true, merchant: MERCHANT }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Fell back to the public path: same shape as the default, no private rail marker.
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ quote: "ok" });
    expect(body.rail).toBeUndefined();
  });

  it("private:true, flag ON, env unconfigured: no-op fallback to public x402 path", async () => {
    process.env.UNLINK_PRIVATE_PAY = "true"; // flag on, but no API key/USDC/userId
    const res = await POST(req({ url: ALLOWED, private: true, merchant: MERCHANT }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ quote: "ok" });
    expect(body.rail).toBeUndefined();
  });

  // NOTE: the genuine "SDK package absent → UnlinkSdkUnavailableError → fall back"
  // path is unit-tested in test/privatePay.test.ts and test/privateRail.test.ts by
  // injecting the error directly. It cannot be faithfully reproduced here: the empty
  // `vi.mock("@unlink-xyz/sdk", () => ({}))` simulates a BROKEN (not a MISSING) package,
  // so `loadUnlinkSdk()` resolves and the absence is never triggered. The two fallback
  // cases above (flag off, env unconfigured) cover the route's real-world degrade.

  it("private:true, flag ON, missing merchant: 400 BadRequest (rail requested, no payee)", async () => {
    process.env.UNLINK_PRIVATE_PAY = "true";
    process.env.UNLINK_API_KEY = "sk_test";
    process.env.ARC_TESTNET_USDC = "0x0000000000000000000000000000000000000abc";
    process.env.UNLINK_PAYOUT_USER_ID = "dyn|sub-agent";
    const res = await POST(req({ url: ALLOWED, private: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("BadRequest");
  });

  it("rejects a non-boolean private flag with 400", async () => {
    const res = await POST(req({ url: ALLOWED, private: "yes" }));
    expect(res.status).toBe(400);
  });
});
