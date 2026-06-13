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
