/**
 * @file quote-lib.test.ts — money-math + staleness/error propagation for lib/quote.ts.
 *
 * The client-side quote helper converts USD <-> 8-decimal router integers and fetches
 * a fresh (never-cached) quote. Money-adjacent invariants (law #4):
 *   - USD<->amount8 rounding is float-safe and round-trips,
 *   - a STALE-price / revert surfaces as `{ error }` so checkout can disable pay,
 *   - the fetch is always `no-store` (a cached price must never reach a buyer),
 *   - a non-ok status or a missing amount never silently returns a usable quote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usdToAmount8,
  amount8ToUsd,
  formatTokenAmount,
  fetchQuote,
  parseUsdAmount8,
} from "../lib/quote.js";

const TOKEN = "0x0000000000000000000000000000000000000001" as const;

describe("usdToAmount8 / amount8ToUsd — money math (float-safe round-trip)", () => {
  it("29.00 -> 2900000000n -> '29.00'", () => {
    const a = usdToAmount8(29);
    expect(a).toBe(2900000000n);
    expect(amount8ToUsd(a)).toBe("29.00");
  });

  it("float-safe: 0.07 does not lose a cent", () => {
    // 0.07 * 1e8 === 7000000.000000001 in IEEE-754; Math.round saves it.
    expect(usdToAmount8(0.07)).toBe(7000000n);
  });

  it("round-trips a range of prices to 2dp", () => {
    for (const usd of [0.01, 1, 4.2, 19.99, 100]) {
      expect(amount8ToUsd(usdToAmount8(usd))).toBe(usd.toFixed(2));
    }
  });
});

describe("parseUsdAmount8 — fail-soft price parse (never throws, never a junk quote)", () => {
  it("parses a real positive price to its 8-decimal integer", () => {
    expect(parseUsdAmount8("29.00")).toBe(2900000000n);
    expect(parseUsdAmount8("0.01")).toBe(1000000n);
    expect(parseUsdAmount8("100")).toBe(10000000000n);
  });

  it("returns null (never throws) for a malformed amount that would crash usdToAmount8", () => {
    // `usdToAmount8(Number('abc'))` === `BigInt(NaN)` → RangeError at render;
    // parseUsdAmount8 must catch these and return null so checkout fails soft.
    for (const bad of ["abc", "", "  ", "1e999", "NaN", "$5", "1,000"]) {
      expect(parseUsdAmount8(bad)).toBeNull();
    }
  });

  it("returns null for a zero or negative price (never quotable)", () => {
    for (const nonPositive of ["0", "0.00", "-5", "-0.01"]) {
      expect(parseUsdAmount8(nonPositive)).toBeNull();
    }
  });

  it("returns null for null/undefined input", () => {
    expect(parseUsdAmount8(null)).toBeNull();
    expect(parseUsdAmount8(undefined)).toBeNull();
  });

  it("returns null (never throws) for a finite USD whose *1e8 overflows to Infinity", () => {
    // Adversarial finding: `1e308` is finite and > 0, so the input `isFinite`
    // guard passed — but `1e308 * 1e8` === Infinity, and `BigInt(Infinity)`
    // threw a RangeError that crashed the buyer-facing card at render. The
    // scaled-result guard must reject it and fail soft to null instead.
    for (const overflow of ["1e308", "5e307"]) {
      expect(() => parseUsdAmount8(overflow)).not.toThrow();
      expect(parseUsdAmount8(overflow)).toBeNull();
    }
  });

  it("returns null for hex/octal/binary/+/whitespace/scientific (never charge a coerced wrong value)", () => {
    // Adversarial finding: `Number()` silently coerces these to a value that
    // mismatches the displayed price (e.g. `0x64` -> 100, ` 100 ` -> 100,
    // `1e3` -> 1000), charging the buyer the wrong amount. The plain-decimal
    // syntax gate must reject them instead of coercing.
    for (const coerced of ["0x64", "0o10", "0b10", "+50", " 100 ", "1e3", "0xFF", " 12.50 "]) {
      expect(parseUsdAmount8(coerced)).toBeNull();
    }
  });

  it("still parses legit plain-decimal prices to the correct 8-decimal integer", () => {
    // Regression: the new guards must not over-reject normal prices.
    expect(parseUsdAmount8("0.5")).toBe(50000000n);
    expect(parseUsdAmount8("12.50")).toBe(1250000000n);
    expect(parseUsdAmount8("100")).toBe(10000000000n);
    expect(parseUsdAmount8("100.12345678")).toBe(10012345678n);
    // "0" is plain-decimal but not positive -> still null (never quotable).
    expect(parseUsdAmount8("0")).toBeNull();
  });

  it("the DISPLAY amount (amount8ToUsd∘parseUsdAmount8) equals the CHARGED amount — no divergence", () => {
    // The checkout header must render exactly what the pay path charges. Before
    // this, the header showed the RAW `?amount=` string while the charge used
    // the parsed value, so a crafted `?amount=4.999` displayed "$4.999" but
    // charged the rounded "$5.00". Deriving the display from the same parsed
    // 8-decimal integer the charge uses removes the divergence and normalizes to
    // proper 2-decimal currency.
    const cases: [string, string][] = [
      ["4.999", "5.00"], // rounds up on the 8-decimal scale, same as the charge
      ["29", "29.00"], // integer input -> proper currency format
      ["4.9", "4.90"], // one decimal -> padded
      ["12.5", "12.50"],
      ["0.01", "0.01"], // already canonical -> unchanged
    ];
    for (const [raw, shown] of cases) {
      const parsed = parseUsdAmount8(raw);
      expect(parsed).not.toBeNull();
      expect(amount8ToUsd(parsed as bigint)).toBe(shown);
    }
  });
});

describe("formatTokenAmount", () => {
  it("formats USDC (6dp) to a 2dp display", () => {
    expect(formatTokenAmount(29010000n, 6)).toBe("29.01");
  });
  it("formats 18dp native to a 2dp display", () => {
    expect(formatTokenAmount(1500000000000000000n, 18)).toBe("1.50");
  });
});

describe("fetchQuote — freshness + truthful error surfacing", () => {
  const base = {
    chainId: 5042002,
    merchantId: 42n,
    token: TOKEN,
    usdAmount8: 2900000000n,
    decimals: 6,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always fetches no-store (a cached/stale price must never reach the buyer)", async () => {
    const spy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ tokenAmount: "29010000" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    const res = await fetchQuote(base);
    expect(res.tokenAmount).toBe(29010000n);
    expect(res.display).toBe("29.01");
    // The fetch must carry cache:'no-store'.
    const init = spy.mock.calls[0][1];
    expect(init?.cache).toBe("no-store");
  });

  it("surfaces a STALE-price revert name as { error } (checkout disables pay)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        // The server route returns the revert NAME with status 200.
        new Response(JSON.stringify({ error: "OracleLib__StalePrice" }), { status: 200 }),
      ),
    );
    const res = await fetchQuote(base);
    expect(res.error).toBe("OracleLib__StalePrice");
    expect(res.tokenAmount).toBeUndefined();
  });

  it("surfaces a non-ok HTTP status as an error, not a usable quote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 500 })),
    );
    const res = await fetchQuote(base);
    expect(res.error).toBeTruthy();
    expect(res.tokenAmount).toBeUndefined();
  });

  it("treats a 200 with no tokenAmount as an error (never a free/blank quote)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    const res = await fetchQuote(base);
    expect(res.error).toBe("Quote returned no amount");
    expect(res.tokenAmount).toBeUndefined();
  });
});
