/**
 * USDC amount helpers for the Unlink private leg.
 *
 * Unlink amounts are in 6-decimal USDC base units (bigint). Converting from a
 * human USD float must be float-safe: `4.20 * 1_000_000` is `4199999.9999…` in
 * IEEE-754, so we round. The spec pins `4.20 -> 4200000` as the regression case.
 */

/** USDC has 6 decimals on Arc (real Circle USDC). */
export const USDC_DECIMALS = 6;
const USDC_SCALE = 1_000_000;

/**
 * Convert a human USD amount to 6-decimal USDC base units.
 *
 * Float-safe: rounds to the nearest base unit so `4.20` maps to exactly
 * `4_200_000n` rather than `4_199_999n`. Throws on non-finite or negative input
 * (a malformed amount must never silently shield/withdraw zero — law #5).
 *
 * @param usd  Human USD amount (e.g. `4.20`).
 * @returns    USDC base units as a `number` (safe-integer range; the SDK takes bigint).
 */
export function usdToUsdcBaseUnits(usd: number): number {
  if (!Number.isFinite(usd)) {
    throw new Error("usdToUsdcBaseUnits: amount must be a finite number");
  }
  if (usd < 0) {
    throw new Error("usdToUsdcBaseUnits: amount must be non-negative");
  }
  return Math.round(usd * USDC_SCALE);
}

/**
 * Convert a base-unit amount (number) to the `bigint` the Unlink SDK expects.
 * Kept separate so the float-safe rounding and the bigint widening are testable
 * in isolation.
 */
export function toUsdcBigInt(baseUnits: number): bigint {
  if (!Number.isInteger(baseUnits)) {
    throw new Error("toUsdcBigInt: base units must be an integer");
  }
  if (baseUnits < 0) {
    throw new Error("toUsdcBigInt: base units must be non-negative");
  }
  return BigInt(baseUnits);
}
