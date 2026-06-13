import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SELLER_ADDRESS must be set BEFORE x402.ts is imported (buildPaymentRequirements
// resolves it; withGateway builds requirements at wrap time).
process.env.SELLER_ADDRESS = "0x000000000000000000000000000000000000dEaD";

// Shared facilitator spy instance — the module-level singleton in x402.ts is
// THIS object, so call-order assertions hold across verify/settle.
const verify = vi.fn();
const settle = vi.fn();

vi.mock("@circle-fin/x402-batching/server", () => ({
  BatchFacilitatorClient: class {
    verify = verify;
    settle = settle;
  },
}));

const ARC_NETWORK = "eip155:5042002";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

// Imported after the mock + env are in place.
const { buildPaymentRequirements, withGateway } = await import(
  "../../lib/x402.js"
);
const { __resetLedger, recentPayments } = await import(
  "../../lib/payment-ledger.js"
);

/** Base64-encode a JSON object into a payment-signature header value. */
function sigHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function decodeHeaderJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

const VALID_PAYLOAD = { x402Version: 1, payload: { sig: "0xabc" } };

beforeEach(() => {
  verify.mockReset();
  settle.mockReset();
  __resetLedger();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildPaymentRequirements — amount math", () => {
  it("$0.001 → 1000", () => {
    expect(buildPaymentRequirements("$0.001").amount).toBe("1000");
  });
  it("$0.01 → 10000", () => {
    expect(buildPaymentRequirements("$0.01").amount).toBe("10000");
  });
  it("$0.03 → 30000", () => {
    expect(buildPaymentRequirements("$0.03").amount).toBe("30000");
  });
  it("$1 → 1000000", () => {
    expect(buildPaymentRequirements("$1").amount).toBe("1000000");
  });
  it("$0.07 → 70000 (float-safety)", () => {
    expect(buildPaymentRequirements("$0.07").amount).toBe("70000");
  });
  it("$0 throws (no free paid endpoints)", () => {
    expect(() => buildPaymentRequirements("$0")).toThrow();
  });
  it("abc throws", () => {
    expect(() => buildPaymentRequirements("abc")).toThrow();
  });
  it("network is the Arc testnet network", () => {
    expect(buildPaymentRequirements("$0.01").network).toBe(ARC_NETWORK);
  });
  it("extra.verifyingContract is the Arc Gateway Wallet", () => {
    expect(buildPaymentRequirements("$0.01").extra.verifyingContract).toBe(
      GATEWAY_WALLET,
    );
  });
  it("extra.name is GatewayWalletBatched", () => {
    expect(buildPaymentRequirements("$0.01").extra.name).toBe(
      "GatewayWalletBatched",
    );
  });
});

describe("buildPaymentRequirements — amount math (raw)", () => {
  it("Math.round(0.001 * 1_000_000) === 1000", () => {
    expect(Math.round(0.001 * 1_000_000)).toBe(1000);
  });
  it("Math.round(0.03 * 1_000_000) === 30000", () => {
    expect(Math.round(0.03 * 1_000_000)).toBe(30000);
  });
  it("Math.round(0.07 * 1_000_000) === 70000", () => {
    expect(Math.round(0.07 * 1_000_000)).toBe(70000);
  });
});

describe("withGateway — revert paths", () => {
  it("no payment-signature header → 402 with base64 PAYMENT-REQUIRED", async () => {
    const h = withGateway(
      async () => Response.json({ ok: true }),
      "$0.01",
      "/api/premium/dataset",
    );
    const res = await h(new Request("https://x/api/premium/dataset"));
    expect(res.status).toBe(402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const decoded = decodeHeaderJson(header as string) as {
      amount: string;
      network: string;
    };
    expect(decoded.amount).toBe("10000");
    expect(decoded.network).toBe(ARC_NETWORK);
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("verify invalid → 402 { reason }; settle + handler never run", async () => {
    verify.mockResolvedValue({ isValid: false, invalidReason: "bad sig" });
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const h = withGateway(handler, "$0.001", "/api/premium/quote");
    const res = await h(
      new Request("https://x/api/premium/quote", {
        headers: { "payment-signature": sigHeader(VALID_PAYLOAD) },
      }),
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("bad sig");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("settle fail → 402 { reason }; handler never runs", async () => {
    verify.mockResolvedValue({ isValid: true, payer: "0xp" });
    settle.mockResolvedValue({ success: false, errorReason: "no balance" });
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const h = withGateway(handler, "$0.001", "/api/premium/quote");
    const res = await h(
      new Request("https://x/api/premium/quote", {
        headers: { "payment-signature": sigHeader(VALID_PAYLOAD) },
      }),
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("no balance");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("malformed payment-signature → 500, never a silent 200", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const h = withGateway(handler, "$0.001", "/api/premium/quote");
    const res = await h(
      new Request("https://x/api/premium/quote", {
        headers: { "payment-signature": "!!!not-base64-json!!!" },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Payment processing error");
    expect(handler).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("withGateway — happy path", () => {
  it("verify before settle before handler; 200 + PAYMENT-RESPONSE + recordPayment", async () => {
    const order: string[] = [];
    verify.mockImplementation(async () => {
      order.push("verify");
      return { isValid: true, payer: "0xPAYER" };
    });
    settle.mockImplementation(async () => {
      order.push("settle");
      return {
        success: true,
        payer: "0xPAYER",
        transaction: "0xBATCHTX",
        network: ARC_NETWORK,
      };
    });
    const handler = vi.fn(async () => {
      order.push("handler");
      return Response.json({ quote: "hi" });
    });

    const h = withGateway(handler, "$0.001", "/api/premium/quote");
    const res = await h(
      new Request("https://x/api/premium/quote", {
        headers: { "payment-signature": sigHeader(VALID_PAYLOAD) },
      }),
    );

    expect(order).toEqual(["verify", "settle", "handler"]);
    expect(res.status).toBe(200);

    const payResp = res.headers.get("PAYMENT-RESPONSE");
    expect(payResp).toBeTruthy();
    const decoded = decodeHeaderJson(payResp as string) as {
      success: boolean;
      transaction: string;
      network: string;
      payer: string;
    };
    expect(decoded).toMatchObject({
      success: true,
      transaction: "0xBATCHTX",
      network: ARC_NETWORK,
      payer: "0xPAYER",
    });

    const recorded = recentPayments();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      endpoint: "/api/premium/quote",
      payer: "0xPAYER",
      amountUsdc: "0.001",
      gatewayTx: "0xBATCHTX",
    });
  });

  it("POST: body read via req.json() AFTER settle", async () => {
    verify.mockResolvedValue({ isValid: true, payer: "0xP" });
    settle.mockResolvedValue({
      success: true,
      payer: "0xP",
      transaction: "0xTX",
      network: ARC_NETWORK,
    });
    const h = withGateway(
      async (req) => {
        const body = (await req.json()) as { input: string };
        return Response.json({ echoed: body.input });
      },
      "$0.03",
      "/api/premium/compute",
    );
    const res = await h(
      new Request("https://x/api/premium/compute", {
        method: "POST",
        headers: {
          "payment-signature": sigHeader(VALID_PAYLOAD),
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "go" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: "go" });
  });

  it("recordPayment subscriber throwing is swallowed; response still 200", async () => {
    verify.mockResolvedValue({ isValid: true, payer: "0xP" });
    settle.mockResolvedValue({
      success: true,
      payer: "0xP",
      transaction: "0xTX",
      network: ARC_NETWORK,
    });
    const { subscribePayments } = await import("../../lib/payment-ledger.js");
    const unsub = subscribePayments(() => {
      throw new Error("ui blew up");
    });
    const h = withGateway(
      async () => Response.json({ ok: true }),
      "$0.001",
      "/api/premium/quote",
    );
    const res = await h(
      new Request("https://x/api/premium/quote", {
        headers: { "payment-signature": sigHeader(VALID_PAYLOAD) },
      }),
    );
    expect(res.status).toBe(200);
    unsub();
  });
});
