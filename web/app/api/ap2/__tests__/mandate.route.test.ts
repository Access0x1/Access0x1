/**
 * @file mandate.route.test.ts — POST /api/ap2/mandate: derivation, structured errors, no money.
 *
 * The route is pure derivation. These pin: a valid SessionGrant body yields an Intent Mandate; a cart
 * yields a hash-bound chain; a bad body / over-budget cart surfaces as a structured 400 (law #5).
 */
import { describe, expect, it } from "vitest";
import { POST } from "../mandate/route.js";

function req(body: unknown): Request {
  return new Request("http://localhost:3000/api/ap2/mandate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GRANT = {
  sessionId: "0xaaaa000000000000000000000000000000000000000000000000000000000001",
  owner: "0x1111111111111111111111111111111111111111",
  delegate: "0x2222222222222222222222222222222222222222",
  budgetCap: "100000000",
  spent: "0",
  expiry: 4_000_000_000,
  nonce: 0,
  token: "0x3600000000000000000000000000000000000000",
  chainId: 5042002,
};

const OPTIONS = { nowSeconds: 1_700_000_000 };

describe("POST /api/ap2/mandate", () => {
  it("returns 400 on invalid JSON", async () => {
    const bad = new Request("http://localhost:3000/api/ap2/mandate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });

  it("returns 400 when grant is missing", async () => {
    const res = await POST(req({ cart: {} }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toMatch(/grant is required/);
  });

  it("returns 400 when grant.budgetCap is not a decimal string", async () => {
    const res = await POST(req({ grant: { ...GRANT, budgetCap: 100 } }));
    expect(res.status).toBe(400);
  });

  it("returns the Intent Mandate alone when no cart is supplied", async () => {
    const res = await POST(req({ grant: GRANT, options: OPTIONS }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mandates.intent.credentialSubject.spendingScope.budgetCap).toBe("100000000");
    expect(body.mandates.cart).toBeUndefined();
    expect(body.note).toMatch(/UNSIGNED/);
  });

  it("returns Intent + Cart when a cart is supplied", async () => {
    const res = await POST(
      req({
        grant: GRANT,
        cart: {
          merchantId: "m1",
          items: [{ name: "x", quantity: 1, unitPrice: "30000000" }],
          totalAmount: "30000000",
        },
        options: OPTIONS,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mandates.cart.credentialSubject.merchantId).toBe("m1");
    expect(body.mandates.cart.credentialSubject.boundTo.mandateId).toBe(body.mandates.intent.id);
  });

  it("returns a full chain with linksValid=true when cart + payment are supplied", async () => {
    const res = await POST(
      req({
        grant: GRANT,
        cart: {
          merchantId: "m1",
          items: [{ name: "x", quantity: 1, unitPrice: "30000000" }],
          totalAmount: "30000000",
        },
        payment: {
          network: "eip155:5042002",
          asset: GRANT.token,
          amount: "30000000",
          payTo: "0x4444444444444444444444444444444444444444",
        },
        options: OPTIONS,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linksValid).toBe(true);
    expect(body.mandates.payment.credentialSubject.rail.protocol).toBe("x402");
  });

  it("returns 400 when the cart total exceeds the mandate budget (law #5)", async () => {
    const res = await POST(
      req({
        grant: GRANT,
        cart: {
          merchantId: "m1",
          items: [{ name: "x", quantity: 1, unitPrice: "200000000" }],
          totalAmount: "200000000", // > 100M cap
        },
        options: OPTIONS,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toMatch(/exceeds the Intent Mandate remaining budget/);
  });
});
