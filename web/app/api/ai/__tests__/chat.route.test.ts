/**
 * @file chat.route.test.ts — POST /api/ai/chat: the connectable AI endpoint.
 *
 * Pins: 401 without a key (no settle); after a successful Circle settle the
 * upstream completion is returned; when CLAUDE_API_KEY is unset the route degrades
 * honestly to a `not_configured` 503 (the payment still settled) and never
 * fabricates a completion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.SELLER_ADDRESS = "0x000000000000000000000000000000000000dEaD";

// Drive Circle verify/settle deterministically.
const verify = vi.fn();
const settle = vi.fn();
vi.mock("@circle-fin/x402-batching/server", () => ({
  BatchFacilitatorClient: class {
    verify = verify;
    settle = settle;
  },
}));

// Mock the Anthropic SDK so the upstream call is deterministic and offline.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status?: number;
  }
  return {
    default: class {
      messages = { create };
      static APIError = APIError;
    },
    APIError,
  };
});

const { POST } = await import("../chat/route.js");
const { connectAiApi } = await import("../../../../lib/ai/connect.js");
const { __resetSessionMeterForTests } = await import("../../../../lib/ai/sessionMeter.js");
const { __resetApiKeysForTests } = await import("../../../../lib/ai/apiKeys.js");

const OWNER = "0x000000000000000000000000000000000000aAaA";
const DELEGATE = "0x000000000000000000000000000000000000bBbB";
const API_KEY = "ak_test_chat_route_key_0123456789";
const FUTURE = Math.floor(Date.now() / 1000) + 86_400;

function sig(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function req(opts: { key?: string; pay?: boolean; prompt?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key) headers["authorization"] = `Bearer ${opts.key}`;
  if (opts.pay) headers["payment-signature"] = sig({ x402Version: 1, payload: {} });
  return new Request("http://localhost:3000/api/ai/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: opts.prompt ?? "Say hi in one word." }),
  });
}

beforeEach(() => {
  verify.mockReset();
  settle.mockReset();
  create.mockReset();
  __resetSessionMeterForTests();
  __resetApiKeysForTests();
  connectAiApi({
    owner: OWNER as `0x${string}`,
    delegate: DELEGATE as `0x${string}`,
    nonce: 0n,
    budgetCapAtomic: 1_000_000n,
    expiry: FUTURE,
    pricePerCallAtomic: 1000n,
    apiKey: API_KEY,
    label: "chat-test",
  });
  delete process.env.CLAUDE_API_KEY;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.CLAUDE_API_KEY;
});

describe("POST /api/ai/chat", () => {
  it("401 without an API key; never settles", async () => {
    const res = await POST(req({ pay: true }));
    expect(res.status).toBe(401);
    expect(settle).not.toHaveBeenCalled();
  });

  it("after settle, returns the upstream completion when CLAUDE_API_KEY is set", async () => {
    process.env.CLAUDE_API_KEY = "sk-test-key-never-logged";
    verify.mockResolvedValue({ isValid: true });
    settle.mockResolvedValue({ success: true, transaction: "0xtx", network: "eip155:5042002", payer: "0xpayer" });
    create.mockResolvedValue({ content: [{ type: "text", text: "Hello." }] });

    const res = await POST(req({ key: API_KEY, pay: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completion: string; paid: string };
    expect(body.completion).toBe("Hello.");
    expect(body.paid).toBe("$0.001");
    expect(create).toHaveBeenCalledOnce();
  });

  it("degrades honestly to not_configured 503 after settle when no upstream key", async () => {
    verify.mockResolvedValue({ isValid: true });
    settle.mockResolvedValue({ success: true, transaction: "0xtx", network: "eip155:5042002", payer: "0xpayer" });

    const res = await POST(req({ key: API_KEY, pay: true }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_configured");
    // The payment settled (handler reached) but the upstream was NOT called.
    expect(create).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledOnce();
  });

  it("never leaks the CLAUDE_API_KEY in the response body", async () => {
    process.env.CLAUDE_API_KEY = "sk-leak-canary-secret";
    verify.mockResolvedValue({ isValid: true });
    settle.mockResolvedValue({ success: true, transaction: "0xtx", network: "eip155:5042002", payer: "0xpayer" });
    create.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const res = await POST(req({ key: API_KEY, pay: true }));
    const text = await res.text();
    expect(text).not.toContain("sk-leak-canary-secret");
  });
});
