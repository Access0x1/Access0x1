/**
 * @file agentMeter.test.ts — never-negative daily budget meter (RED-first contract).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  meterSpendOrThrow,
  meterRefund,
  meterSpent,
  BudgetExceeded,
  __resetMeterForTests,
} from "../agentMeter.js";

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

  it("accumulates spend across calls within the same UTC day", () => {
    meterSpendOrThrow(1);
    meterSpendOrThrow(2);
    expect(meterSpent()).toBe(3);
  });

  it("throws BudgetExceeded when the first charge already exceeds the cap", () => {
    process.env.AGENT_DAILY_USD_CAP = "0.001";
    expect(() => meterSpendOrThrow(0.01)).toThrowError(BudgetExceeded);
    // Rejected charge leaves the ledger untouched (CEI: no partial spend).
    expect(meterSpent()).toBe(0);
  });

  it("carries spent and cap on the BudgetExceeded error", () => {
    process.env.AGENT_DAILY_USD_CAP = "2";
    meterSpendOrThrow(1.5);
    try {
      meterSpendOrThrow(1);
      throw new Error("expected BudgetExceeded");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceeded);
      const e = err as BudgetExceeded;
      expect(e.spent).toBe(1.5);
      expect(e.cap).toBe(2);
    }
  });

  it("never lets the running total exceed the cap across sequential calls", () => {
    process.env.AGENT_DAILY_USD_CAP = "3";
    meterSpendOrThrow(1);
    meterSpendOrThrow(1);
    meterSpendOrThrow(1);
    expect(() => meterSpendOrThrow(0.01)).toThrowError(BudgetExceeded);
    expect(meterSpent()).toBe(3);
  });

  it("meterRefund reduces stored spend", () => {
    meterSpendOrThrow(3);
    meterRefund(1);
    expect(meterSpent()).toBe(2);
  });

  it("meterRefund clamps at zero (never negative) when usd > current spend", () => {
    meterSpendOrThrow(1);
    meterRefund(5);
    expect(meterSpent()).toBe(0);
  });

  it("meterRefund never throws on bad input", () => {
    expect(() => meterRefund(-5)).not.toThrow();
    expect(() => meterRefund(NaN)).not.toThrow();
    expect(() => meterRefund(0)).not.toThrow();
    expect(meterSpent()).toBe(0);
  });

  it("meterSpendOrThrow rejects negative / non-finite amounts", () => {
    expect(() => meterSpendOrThrow(-1)).toThrowError(RangeError);
    expect(() => meterSpendOrThrow(NaN)).toThrowError(RangeError);
  });

  it("resets spend to zero on the next UTC day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T23:59:00Z"));
    meterSpendOrThrow(4);
    expect(meterSpent()).toBe(4);
    vi.setSystemTime(new Date("2026-06-14T00:01:00Z"));
    expect(meterSpent()).toBe(0);
    meterSpendOrThrow(1);
    expect(meterSpent()).toBe(1);
  });

  it("fails safe to a zero cap when AGENT_DAILY_USD_CAP is unset", () => {
    delete process.env.AGENT_DAILY_USD_CAP;
    expect(() => meterSpendOrThrow(0.000001)).toThrowError(BudgetExceeded);
  });

  it("pins the ledger on globalThis so N module instances share ONE daily cap (O-9)", () => {
    // A second route-module copy would re-read the SAME globalThis-keyed ledger, not its own.
    // Asserting the spend is observable on the shared global key proves the cap can't be
    // multiplied by spinning up another instance.
    meterSpendOrThrow(2);
    const g = globalThis as unknown as Record<string, { dayKey: string; spent: number } | undefined>;
    const shared = g["__ax1_agent_meter__"];
    expect(shared).toBeDefined();
    expect(shared?.spent).toBe(2);
    // And the public reader reflects exactly that shared value (one source of truth).
    expect(meterSpent()).toBe(shared?.spent);
  });
});
