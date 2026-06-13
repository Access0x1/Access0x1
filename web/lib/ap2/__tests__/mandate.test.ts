/**
 * @file mandate.test.ts — the AP2 mandate adapter contract.
 *
 * Pins the interop SURFACE: a SessionGrant authorization maps onto a well-formed AP2 Intent Mandate,
 * the Cart and Payment mandates hash-chain to it non-repudiably, and the enforcing edges (budget
 * ceiling, cart-sum, charge==cart) reject overshoot rather than silently accepting it (laws #4/#5).
 */
import { describe, expect, it } from "vitest";
import {
  type SessionGrantAuthorization,
  AP2_CONTEXTS,
  MANDATE_TYPES,
  UNSIGNED_PROOF_TYPE,
  buildCartMandate,
  buildMandateChain,
  buildPaymentMandate,
  contentDigest,
  didForAddress,
  remainingBudget,
  sessionGrantToIntentMandate,
  verifyChainLinks,
} from "../mandate.js";

/** A representative on-chain SessionGrant: 100 USDC (6dp → 100_000000 base units), Arc, live. */
const GRANT: SessionGrantAuthorization = {
  sessionId: "0xaaaa000000000000000000000000000000000000000000000000000000000001",
  owner: "0x1111111111111111111111111111111111111111",
  delegate: "0x2222222222222222222222222222222222222222",
  budgetCap: "100000000",
  spent: "10000000",
  expiry: 4_000_000_000,
  nonce: 0,
  token: "0x3600000000000000000000000000000000000000",
  chainId: 5042002,
};

const NOW = 1_700_000_000;
const OPTS = { nowSeconds: NOW } as const;

describe("sessionGrantToIntentMandate — SessionGrant → AP2 Intent Mandate", () => {
  it("produces a well-formed W3C VC with the AP2 contexts and intent type", () => {
    const intent = sessionGrantToIntentMandate(GRANT, OPTS);
    expect(intent["@context"]).toEqual(AP2_CONTEXTS);
    expect(intent.type).toEqual([MANDATE_TYPES.intent, "VerifiableCredential"]);
    expect(intent.id).toContain(GRANT.sessionId);
  });

  it("maps the SessionGrant scope verbatim: budgetCap, token, expiry, delegate", () => {
    const intent = sessionGrantToIntentMandate(GRANT, OPTS);
    const scope = intent.credentialSubject.spendingScope;
    expect(scope.budgetCap).toBe("100000000");
    expect(scope.spent).toBe("10000000");
    expect(scope.remaining).toBe("90000000"); // 100M - 10M
    expect(scope.token).toBe(GRANT.token);
    expect(scope.expiry).toBe(GRANT.expiry);
    expect(scope.revocable).toBe(true);
    expect(scope.revoked).toBe(false);
  });

  it("the holder is the owner DID and the subject is the delegate DID (did:pkh:eip155)", () => {
    const intent = sessionGrantToIntentMandate(GRANT, OPTS);
    expect(intent.holder).toBe(didForAddress(GRANT.owner, GRANT.chainId));
    expect(intent.credentialSubject.id).toBe(didForAddress(GRANT.delegate, GRANT.chainId));
    expect(intent.holder).toContain("did:pkh:eip155:5042002:");
  });

  it("points back to the canonical on-chain SessionGrant (source of truth)", () => {
    const intent = sessionGrantToIntentMandate(GRANT, OPTS);
    const onChain = intent.credentialSubject.onChainMandate;
    expect(onChain.standard).toBe("Access0x1.SessionGrant");
    expect(onChain.sessionId).toBe(GRANT.sessionId);
    expect(onChain.owner).toBe(GRANT.owner);
    expect(onChain.delegate).toBe(GRANT.delegate);
    expect(onChain.nonce).toBe(GRANT.nonce);
  });

  it("emits an UNSIGNED proof stub (never a forged signature — law #4)", () => {
    const intent = sessionGrantToIntentMandate(GRANT, OPTS);
    expect(intent.proof.type).toBe(UNSIGNED_PROOF_TYPE);
    expect(intent.proof.proofPurpose).toBe("assertionMethod");
    expect(intent.proof.note).toMatch(/UNSIGNED/);
    expect(intent.proof.contentDigest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const a = sessionGrantToIntentMandate(GRANT, OPTS);
    const b = sessionGrantToIntentMandate(GRANT, OPTS);
    expect(contentDigest(a)).toBe(contentDigest(b));
  });
});

describe("remainingBudget — mirrors on-chain remaining()", () => {
  it("returns budgetCap - spent for a live grant", () => {
    expect(remainingBudget(GRANT, NOW)).toBe("90000000");
  });
  it("returns 0 for a revoked grant", () => {
    expect(remainingBudget({ ...GRANT, revoked: true }, NOW)).toBe("0");
  });
  it("returns 0 for an expired grant", () => {
    expect(remainingBudget(GRANT, GRANT.expiry + 1)).toBe("0");
  });
  it("clamps at 0 if spent somehow exceeds the cap (never negative)", () => {
    expect(remainingBudget({ ...GRANT, spent: "200000000" }, NOW)).toBe("0");
  });
});

describe("buildCartMandate / buildPaymentMandate — non-repudiable hash chain", () => {
  const intent = sessionGrantToIntentMandate(GRANT, OPTS);
  const cartInput = {
    merchantId: "merchant_demo_001",
    items: [
      { name: "API call bundle", quantity: 2, unitPrice: "20000000" }, // 40M
      { name: "Premium dataset", quantity: 1, unitPrice: "10000000" }, // 10M
    ],
    totalAmount: "50000000", // 50M, within 90M remaining
  };
  const paymentInput = {
    network: "eip155:5042002",
    asset: GRANT.token,
    amount: "50000000",
    payTo: "0x4444444444444444444444444444444444444444" as const,
  };

  it("binds the Cart Mandate to the Intent Mandate by id + content digest", () => {
    const cart = buildCartMandate(intent, cartInput, OPTS);
    expect(cart.credentialSubject.boundTo.mandateId).toBe(intent.id);
    expect(cart.credentialSubject.boundTo.contentDigest).toBe(contentDigest(intent));
  });

  it("binds the Payment Mandate to the Cart Mandate and references the x402 rail", () => {
    const cart = buildCartMandate(intent, cartInput, OPTS);
    const payment = buildPaymentMandate(cart, paymentInput, OPTS);
    expect(payment.credentialSubject.boundTo.mandateId).toBe(cart.id);
    expect(payment.credentialSubject.boundTo.contentDigest).toBe(contentDigest(cart));
    expect(payment.credentialSubject.rail.protocol).toBe("x402");
    expect(payment.credentialSubject.rail.extension).toBe("ap2-x402");
    expect(payment.credentialSubject.agentPresent).toBe(true);
  });

  it("rejects a cart whose line items do not sum to the stated total (law #5)", () => {
    expect(() =>
      buildCartMandate(intent, { ...cartInput, totalAmount: "49999999" }, OPTS),
    ).toThrow(/does not equal totalAmount/);
  });

  it("rejects a cart total exceeding the Intent Mandate remaining budget (law #5)", () => {
    expect(() =>
      buildCartMandate(
        intent,
        {
          merchantId: "m",
          items: [{ name: "Too big", quantity: 1, unitPrice: "95000000" }],
          totalAmount: "95000000", // > 90M remaining
        },
        OPTS,
      ),
    ).toThrow(/exceeds the Intent Mandate remaining budget/);
  });

  it("rejects a payment amount that does not equal the bound cart total (no skim — law #5)", () => {
    const cart = buildCartMandate(intent, cartInput, OPTS);
    expect(() =>
      buildPaymentMandate(cart, { ...paymentInput, amount: "60000000" }, OPTS),
    ).toThrow(/does not equal the bound cart total/);
  });
});

describe("buildMandateChain + verifyChainLinks — end-to-end", () => {
  const cartInput = {
    merchantId: "merchant_demo_001",
    items: [{ name: "Booking", quantity: 1, unitPrice: "30000000" }],
    totalAmount: "30000000",
  };
  const paymentInput = {
    network: "eip155:5042002",
    asset: GRANT.token,
    amount: "30000000",
    payTo: "0x4444444444444444444444444444444444444444" as const,
  };

  it("builds Intent ← Cart ← Payment with intact hash links", () => {
    const chain = buildMandateChain(GRANT, cartInput, paymentInput, OPTS);
    expect(chain.intent.type[0]).toBe(MANDATE_TYPES.intent);
    expect(chain.cart.type[0]).toBe(MANDATE_TYPES.cart);
    expect(chain.payment.type[0]).toBe(MANDATE_TYPES.payment);
    expect(verifyChainLinks(chain)).toBeNull();
  });

  it("detects tampering: mutating the Intent Mandate breaks the Cart link", () => {
    const chain = buildMandateChain(GRANT, cartInput, paymentInput, OPTS);
    const tampered = {
      ...chain,
      intent: {
        ...chain.intent,
        credentialSubject: {
          ...chain.intent.credentialSubject,
          spendingScope: {
            ...chain.intent.credentialSubject.spendingScope,
            budgetCap: "999999999", // attacker inflates the cap
          },
        },
      },
    };
    expect(verifyChainLinks(tampered)).toMatch(/Cart Mandate boundTo digest/);
  });

  it("detects tampering: mutating the Cart Mandate breaks the Payment link", () => {
    const chain = buildMandateChain(GRANT, cartInput, paymentInput, OPTS);
    const tampered = {
      ...chain,
      cart: {
        ...chain.cart,
        credentialSubject: { ...chain.cart.credentialSubject, totalAmount: "1" },
      },
    };
    expect(verifyChainLinks(tampered)).toMatch(/Payment Mandate boundTo digest/);
  });
});
