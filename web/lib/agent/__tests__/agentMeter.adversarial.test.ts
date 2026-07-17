/**
 * @file agentMeter.adversarial.test.ts — never-negative / never-double-spend edges.
 *
 * The meter is the only thing bounding the autonomous agent's real-USDC spend, so
 * these pin the invariants an attacker (or a buggy loop) would try to break — run
 * against the PRODUCTION {reserveDailySpend}/{refundDailySpend} path (no DB ⇒ the
 * in-memory fail-soft branch):
 *   - the running total can NEVER exceed the cap, even across many sequential charges
 *     that each individually fit (no double-spend past the cap),
 *   - the spend can NEVER go negative, no matter how refunds and charges interleave,
 *   - the exact-boundary charge (spent + usd === cap) is ALLOWED (the cap is inclusive,
 *     not off-by-one strict),
 *   - float drift fails SAFE — it may reject a charge that mathematically equals the
 *     cap, but it must never let the stored spend creep above the cap.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  reserveDailySpend,
  refundDailySpend,
  meterSpent,
  BudgetExceeded,
  __resetMeterForTests,
} from "../agentMeter.js";

/** A refund receipt for the in-memory (no-DB) path — never touches a durable row. */
const INMEM = { durable: false } as const;

describe("agentMeter — adversarial invariants", () => {
  beforeEach(() => {
    __resetMeterForTests();
    process.env.AGENT_DAILY_USD_CAP = "1.00";
  });
  afterEach(() => {
    __resetMeterForTests();
  });

  it("the exact-boundary charge (spent + usd === cap) is allowed", async () => {
    await reserveDailySpend(0.6);
    // 0.6 + 0.4 === 1.00 exactly — must NOT reject.
    await expect(reserveDailySpend(0.4)).resolves.toBeDefined();
    expect(meterSpent()).toBeCloseTo(1.0, 10);
    // One more cent must now be rejected.
    await expect(reserveDailySpend(0.01)).rejects.toThrowError(BudgetExceeded);
  });

  it("never double-spends past the cap across many individually-fitting charges", async () => {
    process.env.AGENT_DAILY_USD_CAP = "0.05";
    let accepted = 0;
    // 100 attempted micro-charges of $0.001 against a $0.05 cap.
    for (let i = 0; i < 100; i++) {
      try {
        await reserveDailySpend(0.001);
        accepted += 1;
      } catch (e) {
        expect(e).toBeInstanceOf(BudgetExceeded);
      }
    }
    // At most 50 charges of $0.001 fit in $0.05; the stored spend never exceeds the cap.
    expect(accepted).toBeLessThanOrEqual(50);
    expect(meterSpent()).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it("never goes negative no matter how charges and refunds interleave", async () => {
    process.env.AGENT_DAILY_USD_CAP = "10";
    const ops: Array<["spend" | "refund", number]> = [
      ["spend", 3],
      ["refund", 5], // over-refund — must clamp at 0, not -2
      ["spend", 2],
      ["refund", 100], // huge over-refund
      ["spend", 1],
      ["refund", 0.5],
    ];
    for (const [kind, amt] of ops) {
      if (kind === "spend") {
        try {
          await reserveDailySpend(amt);
        } catch {
          /* over-cap charge ignored for this interleave test */
        }
      } else {
        await refundDailySpend(amt, INMEM);
      }
      // The invariant under test: spend is never negative at ANY point.
      expect(meterSpent()).toBeGreaterThanOrEqual(0);
    }
    expect(meterSpent()).toBeGreaterThanOrEqual(0);
  });

  it("a refund of the full spent amount returns exactly to zero (not below)", async () => {
    process.env.AGENT_DAILY_USD_CAP = "10";
    await reserveDailySpend(2.5);
    await refundDailySpend(2.5, INMEM);
    expect(meterSpent()).toBe(0);
    // And a subsequent over-refund stays at zero.
    await refundDailySpend(1, INMEM);
    expect(meterSpent()).toBe(0);
  });

  it("float drift fails SAFE: stored spend never creeps above the cap", async () => {
    // 50 * 0.001 === 0.05000000000000004 in IEEE-754. With cap exactly 0.05, the
    // 50th charge may be rejected — that is acceptable (fails safe). What is NOT
    // acceptable is the stored spend exceeding the cap.
    process.env.AGENT_DAILY_USD_CAP = "0.05";
    for (let i = 0; i < 60; i++) {
      try {
        await reserveDailySpend(0.001);
      } catch {
        /* expected once the running total reaches the cap */
      }
      expect(meterSpent()).toBeLessThanOrEqual(0.05);
    }
  });
});
