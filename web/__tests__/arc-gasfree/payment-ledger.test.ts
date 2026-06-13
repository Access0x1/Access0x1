import { afterEach, describe, expect, it } from "vitest";

import {
  __resetLedger,
  recentPayments,
  recordPayment,
  subscribePayments,
  type PaymentEvent,
} from "../../lib/payment-ledger.js";

function evt(i: number): PaymentEvent {
  return {
    endpoint: "/api/premium/quote",
    payer: `0xpayer${i}`,
    amountUsdc: "0.001",
    network: "eip155:5042002",
    gatewayTx: `0xtx${i}`,
    ts: i,
  };
}

describe("payment-ledger", () => {
  afterEach(() => __resetLedger());

  it("caps the ring at 200 entries (entry 201 evicts entry 1)", () => {
    for (let i = 1; i <= 201; i++) recordPayment(evt(i));
    const all = recentPayments();
    expect(all).toHaveLength(200);
    // entry 1 (payer 0xpayer1) is evicted; the oldest retained is entry 2.
    const payers = all.map((e) => e.payer);
    expect(payers).not.toContain("0xpayer1");
    expect(payers).toContain("0xpayer2");
    expect(payers).toContain("0xpayer201");
  });

  it("recentPayments returns newest-first", () => {
    recordPayment(evt(1));
    recordPayment(evt(2));
    recordPayment(evt(3));
    const recent = recentPayments();
    expect(recent.map((e) => e.payer)).toEqual([
      "0xpayer3",
      "0xpayer2",
      "0xpayer1",
    ]);
  });

  it("isolates a subscriber error (does not throw to caller)", () => {
    let received = 0;
    subscribePayments(() => {
      throw new Error("subscriber blew up");
    });
    subscribePayments(() => {
      received += 1;
    });
    expect(() => recordPayment(evt(1))).not.toThrow();
    // The good subscriber still ran, and the payment was still recorded.
    expect(received).toBe(1);
    expect(recentPayments()).toHaveLength(1);
  });
});
