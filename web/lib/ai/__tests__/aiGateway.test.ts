/**
 * @file aiGateway.test.ts — `withAiGateway` composition + CEI + refund-on-miss.
 *
 * Pins the layer order: no key → 401 (no settle); over-budget → 402 (no settle);
 * valid key + budget + successful Circle settle → handler runs (200) and the
 * reservation is KEPT; a 402 from the inner gateway (challenge / verify-fail /
 * settle-fail) REFUNDS the reservation (law #5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SELLER_ADDRESS must be set BEFORE x402.ts is imported (withGateway resolves it).
process.env.SELLER_ADDRESS = "0x000000000000000000000000000000000000dEaD";

// Mock the Circle batch facilitator so we drive verify/settle deterministically.
const verify = vi.fn();
const settle = vi.fn();
vi.mock("@circle-fin/x402-batching/server", () => ({
  BatchFacilitatorClient: class {
    verify = verify;
    settle = settle;
  },
}));

const { withAiGateway } = await import("../aiGateway.js");
const { connectAiApi } = await import("../connect.js");
const { remaining } = await import("../sessionMeter.js");
const { __resetSessionMeterForTests } = await import("../sessionMeter.js");
const { __resetApiKeysForTests } = await import("../apiKeys.js");

const OWNER = "0x000000000000000000000000000000000000aAaA";
const DELEGATE = "0x000000000000000000000000000000000000bBbB";
const API_KEY = "ak_test_gateway_key_0123456789ab";
const FUTURE = Math.floor(Date.now() / 1000) + 86_400;

/** Base64 a JSON object into a payment-signature header value. */
function sig(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/** The post-settle handler under test — returns a marker so we know it ran. */
async function handler(): Promise<Response> {
  return Response.json({ served: true });
}

/** Build a request with optional bearer + payment-signature headers. */
function req(opts: { key?: string; pay?: boolean } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key) headers["authorization"] = `Bearer ${opts.key}`;
  if (opts.pay) headers["payment-signature"] = sig({ x402Version: 1, payload: {} });
  return new Request("http://localhost:3000/api/ai/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "hi" }),
  });
}

let sessionId: string;

beforeEach(() => {
  verify.mockReset();
  settle.mockReset();
  __resetSessionMeterForTests();
  __resetApiKeysForTests();
  // Connect: open a $0.005 session budget and bind the key at $0.001/call.
  const r = connectAiApi({
    owner: OWNER as `0x${string}`,
    delegate: DELEGATE as `0x${string}`,
    nonce: 0n,
    budgetCapAtomic: 5_000n, // $0.005 → exactly 5 calls at $0.001
    expiry: FUTURE,
    pricePerCallAtomic: 1000n,
    apiKey: API_KEY,
    label: "test",
  });
  sessionId = r.sessionId;
});

afterEach(() => {
  vi.clearAllMocks();
});

const wrapped = () => withAiGateway(handler, "$0.001", "/api/ai/chat");

describe("layer 1 — API-key auth (before any settle)", () => {
  it("401 with no Authorization header; never calls the facilitator", async () => {
    const res = await wrapped()(req());
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("401 with an invalid key; budget untouched", async () => {
    const res = await wrapped()(req({ key: "ak_wrong_key_000000000000" }));
    expect(res.status).toBe(401);
    expect(remaining(sessionId as `0x${string}`)).toBe(5_000n);
  });
});

describe("layer 2 — SessionGrant budget (before settle)", () => {
  it("402 SessionBudgetExceeded once the budget is exhausted; no settle", async () => {
    verify.mockResolvedValue({ isValid: true });
    settle.mockResolvedValue({ success: true, transaction: "0xtx", network: "eip155:5042002", payer: "0xpayer" });
    // Spend all 5 calls.
    for (let i = 0; i < 5; i++) {
      const ok = await wrapped()(req({ key: API_KEY, pay: true }));
      expect(ok.status).toBe(200);
    }
    expect(remaining(sessionId as `0x${string}`)).toBe(0n);
    // 6th call: budget rejects BEFORE the facilitator is consulted.
    verify.mockClear();
    settle.mockClear();
    const res = await wrapped()(req({ key: API_KEY, pay: true }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("SessionBudgetExceeded");
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("layer 3/4 — settle keeps the reservation, a miss refunds it", () => {
  it("valid key + budget + successful settle → 200, handler ran, reservation kept", async () => {
    verify.mockResolvedValue({ isValid: true });
    settle.mockResolvedValue({ success: true, transaction: "0xtx", network: "eip155:5042002", payer: "0xpayer" });
    const res = await wrapped()(req({ key: API_KEY, pay: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ served: true });
    expect(remaining(sessionId as `0x${string}`)).toBe(4_000n); // one $0.001 spent
  });

  it("inner gateway 402 (no payment-signature → challenge) refunds the reservation", async () => {
    const res = await wrapped()(req({ key: API_KEY })); // no pay header → inner 402 challenge
    expect(res.status).toBe(402);
    // The reservation was made then released because nothing settled (law #5).
    expect(remaining(sessionId as `0x${string}`)).toBe(5_000n);
    expect(settle).not.toHaveBeenCalled();
  });

  it("settle failure → inner 402, reservation refunded", async () => {
    verify.mockResolvedValue({ isValid: true });
    settle.mockResolvedValue({ success: false, errorReason: "insufficient" });
    const res = await wrapped()(req({ key: API_KEY, pay: true }));
    expect(res.status).toBe(402);
    expect(remaining(sessionId as `0x${string}`)).toBe(5_000n); // refunded
  });

  it("malformed payment-signature → inner 500 (NOT 402), reservation still refunded", async () => {
    // decodeHeader throws on a non-base64/non-JSON signature → withGateway returns
    // HTTP 500, not 402. No USDC settled and no PAYMENT-RESPONSE header is set, so the
    // reservation MUST be released — keying the refund off status===402 alone leaked
    // budget on this path (a client could burn its own budget with garbled sigs).
    const bad = new Request("http://localhost:3000/api/ai/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
        "payment-signature": "!!!not-base64-json!!!",
      },
      body: JSON.stringify({ prompt: "hi" }),
    });
    const res = await wrapped()(bad);
    expect(res.status).toBe(500);
    expect(res.headers.has("PAYMENT-RESPONSE")).toBe(false);
    expect(remaining(sessionId as `0x${string}`)).toBe(5_000n); // refunded, not debited
    expect(settle).not.toHaveBeenCalled();
  });
});
