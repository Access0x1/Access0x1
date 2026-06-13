import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, normalizeUsdc } from "../../app/api/gateway/balance/route.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.SELLER_ADDRESS = "0x000000000000000000000000000000000000dEaD";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("normalizeUsdc — decimal vs atomic", () => {
  it("decimal '5.00' → '5.000000'", () => {
    expect(normalizeUsdc("5.00")).toBe("5.000000");
  });
  it("atomic '5000000' → '5.000000'", () => {
    expect(normalizeUsdc("5000000")).toBe("5.000000");
  });
  it("atomic '1000' → '0.001000'", () => {
    expect(normalizeUsdc("1000")).toBe("0.001000");
  });
  it("missing → zero", () => {
    expect(normalizeUsdc(undefined)).toBe("0.000000");
    expect(normalizeUsdc(null)).toBe("0.000000");
    expect(normalizeUsdc("")).toBe("0.000000");
  });
});

describe("GET /api/gateway/balance", () => {
  it("missing SELLER_ADDRESS → 500", async () => {
    delete process.env.SELLER_ADDRESS;
    const res = await GET();
    expect(res.status).toBe(500);
  });

  it("decimal API response → both '5.000000'", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        gateway: { available: "5.00" },
        wallet: { balance: "5.00" },
      }),
    ) as typeof fetch;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      gateway: "5.000000",
      wallet: "5.000000",
    });
  });

  it("atomic API response → both '5.000000'", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ available: "5000000", balance: "5000000" }),
    ) as typeof fetch;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      gateway: "5.000000",
      wallet: "5.000000",
    });
  });

  it("Circle API error → 200 zero fallback (never 500)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      gateway: "0.000000",
      wallet: "0.000000",
    });
  });

  it("non-ok Circle response → 200 zero fallback", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("oops", { status: 503 }),
    ) as typeof fetch;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      gateway: "0.000000",
      wallet: "0.000000",
    });
  });
});
