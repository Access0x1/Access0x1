/**
 * @file agentMeter.test.ts — never-negative daily budget meter (RED-first contract).
 *
 * Exercises the PRODUCTION entry points {reserveDailySpend}/{refundDailySpend} directly
 * (no DB configured ⇒ the in-memory fail-soft path), so these pin the ledger math on the
 * exact code the agent pay route runs — not a separate sync shim.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  reserveDailySpend,
  refundDailySpend,
  meterSpent,
  BudgetExceeded,
  __resetMeterForTests,
} from "../agentMeter.js";

/** A refund receipt for the in-memory (no-DB) path — never touches a durable row. */
const INMEM = { durable: false } as const;

describe("agentMeter", () => {
  beforeEach(() => {
    __resetMeterForTests();
    process.env.AGENT_DAILY_USD_CAP = "5.00";
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetMeterForTests();
  });

  it("accumulates spend across calls within the same UTC day", async () => {
    await reserveDailySpend(1);
    await reserveDailySpend(2);
    expect(meterSpent()).toBe(3);
  });

  it("rejects with BudgetExceeded when the first charge already exceeds the cap", async () => {
    process.env.AGENT_DAILY_USD_CAP = "0.001";
    await expect(reserveDailySpend(0.01)).rejects.toThrowError(BudgetExceeded);
    // Rejected charge leaves the ledger untouched (CEI: no partial spend).
    expect(meterSpent()).toBe(0);
  });

  it("carries spent and cap on the BudgetExceeded error", async () => {
    process.env.AGENT_DAILY_USD_CAP = "2";
    await reserveDailySpend(1.5);
    try {
      await reserveDailySpend(1);
      throw new Error("expected BudgetExceeded");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceeded);
      const e = err as BudgetExceeded;
      expect(e.spent).toBe(1.5);
      expect(e.cap).toBe(2);
    }
  });

  it("never lets the running total exceed the cap across sequential calls", async () => {
    process.env.AGENT_DAILY_USD_CAP = "3";
    await reserveDailySpend(1);
    await reserveDailySpend(1);
    await reserveDailySpend(1);
    await expect(reserveDailySpend(0.01)).rejects.toThrowError(BudgetExceeded);
    expect(meterSpent()).toBe(3);
  });

  it("refundDailySpend reduces stored spend", async () => {
    await reserveDailySpend(3);
    await refundDailySpend(1, INMEM);
    expect(meterSpent()).toBe(2);
  });

  it("refundDailySpend clamps at zero (never negative) when usd > current spend", async () => {
    await reserveDailySpend(1);
    await refundDailySpend(5, INMEM);
    expect(meterSpent()).toBe(0);
  });

  it("refundDailySpend never throws on bad input", async () => {
    await expect(refundDailySpend(-5, INMEM)).resolves.toBeUndefined();
    await expect(refundDailySpend(NaN, INMEM)).resolves.toBeUndefined();
    await expect(refundDailySpend(0, INMEM)).resolves.toBeUndefined();
    expect(meterSpent()).toBe(0);
  });

  it("reserveDailySpend rejects negative / non-finite amounts", async () => {
    await expect(reserveDailySpend(-1)).rejects.toThrowError(RangeError);
    await expect(reserveDailySpend(NaN)).rejects.toThrowError(RangeError);
  });

  it("resets spend to zero on the next UTC day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T23:59:00Z"));
    await reserveDailySpend(4);
    expect(meterSpent()).toBe(4);
    vi.setSystemTime(new Date("2026-06-14T00:01:00Z"));
    expect(meterSpent()).toBe(0);
    await reserveDailySpend(1);
    expect(meterSpent()).toBe(1);
  });

  it("fails safe to a zero cap when AGENT_DAILY_USD_CAP is unset", async () => {
    delete process.env.AGENT_DAILY_USD_CAP;
    await expect(reserveDailySpend(0.000001)).rejects.toThrowError(BudgetExceeded);
  });

  it("pins the ledger on globalThis so N module instances share ONE daily cap (O-9)", async () => {
    // A second route-module copy would re-read the SAME globalThis-keyed ledger, not its own.
    // Asserting the spend is observable on the shared global key proves the cap can't be
    // multiplied by spinning up another instance.
    await reserveDailySpend(2);
    const g = globalThis as unknown as Record<string, { dayKey: string; spent: number } | undefined>;
    const shared = g["__ax1_agent_meter__"];
    expect(shared).toBeDefined();
    expect(shared?.spent).toBe(2);
    // And the public reader reflects exactly that shared value (one source of truth).
    expect(meterSpent()).toBe(shared?.spent);
  });
});
