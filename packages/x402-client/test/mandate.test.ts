import { describe, expect, it } from "vitest";
import { Access0x1Payer, PaymentRailError, type SessionGrantAuthorization } from "../src/index.js";
import { headerValue, jsonResponse, mockFetch, parseInitBody } from "./helpers.js";

const BASE = "https://pay.example.com";
const MANDATE_URL = `${BASE}/api/ap2/mandate`;

const GRANT: SessionGrantAuthorization = {
  sessionId: "0xabc0000000000000000000000000000000000000000000000000000000000001",
  owner: "0x1111111111111111111111111111111111111111",
  delegate: "0x2222222222222222222222222222222222222222",
  token: "0x3333333333333333333333333333333333333333",
  budgetCap: "1000000",
  spent: "0",
  expiry: 1893456000,
  nonce: 1,
  chainId: 5042002,
};

describe("Access0x1Payer.deriveMandate", () => {
  it("derives an intent mandate and surfaces the onChainTruth caveat", async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url === MANDATE_URL) {
        return jsonResponse(200, {
          ok: true,
          mandates: { intent: { id: "urn:intent:1" } },
          note: "Mandates carry an UNSIGNED proof stub.",
          onChainTruth: "DERIVED, NOT AUTHORITATIVE: re-verify the SessionGrant on-chain.",
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const payer = new Access0x1Payer({ baseUrl: BASE, callerAuth: "sek", fetchImpl });

    const res = await payer.deriveMandate({ grant: GRANT });
    expect(res.onChainTruth).toContain("DERIVED, NOT AUTHORITATIVE");
    expect(res.mandates).toEqual({ intent: { id: "urn:intent:1" } });
    // The request body carries the exact `grant` shape — no invented fields.
    expect(parseInitBody(calls[0]?.init)).toEqual({ grant: GRANT });
    expect(headerValue(calls[0]?.init, "x-internal-secret")).toBe("sek");
  });

  it("forwards cart + payment and reports linksValid", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse(200, { ok: true, mandates: {}, linksValid: true, onChainTruth: "x" }),
    );
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });

    const cart = {
      merchantId: "m1",
      items: [{ name: "API call", quantity: 1, unitPrice: "1000" }],
      totalAmount: "1000",
    };
    const payment = {
      network: "eip155:5042002",
      asset: "0x3600000000000000000000000000000000000000" as const,
      amount: "1000",
      payTo: "0x4444444444444444444444444444444444444444" as const,
      scheme: "exact" as const,
    };
    const res = await payer.deriveMandate({ grant: GRANT, cart, payment });
    expect(res.linksValid).toBe(true);
    expect(parseInitBody(calls[0]?.init)).toEqual({ grant: GRANT, cart, payment });
  });

  it("throws PaymentRailError on a 400 from the mandate endpoint", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(400, { error: "BadRequest", reason: "grant.owner must be a 0x address" }),
    );
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });
    await expect(payer.deriveMandate({ grant: GRANT })).rejects.toBeInstanceOf(PaymentRailError);
  });
});
