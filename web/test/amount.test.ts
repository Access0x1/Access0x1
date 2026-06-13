import { describe, it, expect } from "vitest";
import { usdToUsdcBaseUnits, toUsdcBigInt, USDC_DECIMALS } from "../lib/unlink/amount.js";

describe("amount math (USD -> 6-dec USDC base units)", () => {
  it("USDC has 6 decimals", () => {
    expect(USDC_DECIMALS).toBe(6);
  });

  it("4.20 -> 4200000 (float-safety regression)", () => {
    expect(usdToUsdcBaseUnits(4.2)).toBe(4_200_000);
  });

  it("50 -> 50000000", () => {
    expect(usdToUsdcBaseUnits(50)).toBe(50_000_000);
  });

  it("0.01 -> 10000", () => {
    expect(usdToUsdcBaseUnits(0.01)).toBe(10_000);
  });

  it("rounds half-cents to the nearest base unit", () => {
    expect(usdToUsdcBaseUnits(1.2345678)).toBe(1_234_568);
  });

  it("rejects negative amounts", () => {
    expect(() => usdToUsdcBaseUnits(-1)).toThrow(/non-negative/);
  });

  it("rejects non-finite amounts", () => {
    expect(() => usdToUsdcBaseUnits(Number.NaN)).toThrow(/finite/);
    expect(() => usdToUsdcBaseUnits(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("toUsdcBigInt widens an integer to bigint", () => {
    expect(toUsdcBigInt(4_200_000)).toBe(4_200_000n);
  });

  it("toUsdcBigInt rejects non-integers and negatives", () => {
    expect(() => toUsdcBigInt(1.5)).toThrow(/integer/);
    expect(() => toUsdcBigInt(-1)).toThrow(/non-negative/);
  });
});
