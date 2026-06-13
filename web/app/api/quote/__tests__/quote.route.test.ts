/**
 * @file quote.route.test.ts — adversarial input validation + truthful error surfacing
 * for GET /api/quote (lib/quote's server side).
 *
 * Money-adjacent guard (law #4: never a silent wrong price). The route reads an
 * untrusted querystring and quotes the on-chain router. These tests pin:
 *   - junk / NaN / negative / zero numeric params are rejected with a clean 400
 *     BEFORE any chain lookup (so a malformed chainId can't leak into a confusing 500,
 *     and a negative/zero price can never be quoted),
 *   - a missing router-address config surfaces LOUD (500), never a silent 200,
 *   - a contract revert surfaces the revert NAME so checkout shows an honest error.
 *
 * The chain + contract layers are mocked so the route's own logic is tested in
 * isolation (no live RPC).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseError, ContractFunctionRevertedError } from "viem";

// ── Mocks: keep the route off any live RPC. ──────────────────────────────────
const getRouterAddress = vi.fn();
const getChain = vi.fn();
const getRpcUrl = vi.fn();
const getQuote = vi.fn();

vi.mock("@/lib/chains", () => ({
  getRouterAddress: (id: number) => getRouterAddress(id),
  getChain: (id: number) => getChain(id),
  getRpcUrl: (id: number) => getRpcUrl(id),
}));
vi.mock("@/lib/contracts", () => ({
  getQuote: (...args: unknown[]) => getQuote(...args),
}));

const { GET } = await import("../route.js");

const ARC = 5042002;
const TOKEN = "0x0000000000000000000000000000000000000001";

function reqUrl(params: Record<string, string>): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(`https://x/api/quote?${qs}`);
}

beforeEach(() => {
  getRouterAddress.mockReset().mockReturnValue("0xRouter0000000000000000000000000000000001");
  getChain.mockReset().mockReturnValue({ id: ARC });
  getRpcUrl.mockReset().mockReturnValue("https://rpc.example");
  getQuote.mockReset().mockResolvedValue(2901000000n);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/quote — input validation (adversarial)", () => {
  it("happy path returns the token amount as a string", async () => {
    const res = await GET(
      reqUrl({ chainId: String(ARC), merchantId: "42", token: TOKEN, usdAmount8: "2900000000" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokenAmount: "2901000000" });
  });

  it("400 when any required param is missing", async () => {
    const res = await GET(reqUrl({ chainId: String(ARC), merchantId: "42", token: TOKEN }));
    expect(res.status).toBe(400);
    expect(getRouterAddress).not.toHaveBeenCalled();
  });

  it("400 for a non-numeric chainId (NaN must not leak into a 500)", async () => {
    const res = await GET(
      reqUrl({ chainId: "abc", merchantId: "42", token: TOKEN, usdAmount8: "2900000000" }),
    );
    expect(res.status).toBe(400);
    // The chain layer must never be touched with a junk id.
    expect(getRouterAddress).not.toHaveBeenCalled();
  });

  it("400 for a zero or negative chainId", async () => {
    for (const bad of ["0", "-5042002"]) {
      const res = await GET(
        reqUrl({ chainId: bad, merchantId: "42", token: TOKEN, usdAmount8: "2900000000" }),
      );
      expect(res.status).toBe(400);
    }
    expect(getRouterAddress).not.toHaveBeenCalled();
  });

  it("400 for a fractional chainId", async () => {
    const res = await GET(
      reqUrl({ chainId: "5042002.5", merchantId: "42", token: TOKEN, usdAmount8: "2900000000" }),
    );
    expect(res.status).toBe(400);
    expect(getRouterAddress).not.toHaveBeenCalled();
  });

  it("400 for a non-integer merchantId / usdAmount8 (BigInt would throw)", async () => {
    const res = await GET(
      reqUrl({ chainId: String(ARC), merchantId: "4.5", token: TOKEN, usdAmount8: "2900000000" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 for a NEGATIVE usdAmount8 — a negative price must never be quoted (law #4)", async () => {
    const res = await GET(
      reqUrl({ chainId: String(ARC), merchantId: "42", token: TOKEN, usdAmount8: "-1" }),
    );
    expect(res.status).toBe(400);
    // Reaching the contract with a negative price would be a wrong-price hazard.
    expect(getQuote).not.toHaveBeenCalled();
  });

  it("400 for a ZERO usdAmount8 — no free quote (law #4)", async () => {
    const res = await GET(
      reqUrl({ chainId: String(ARC), merchantId: "42", token: TOKEN, usdAmount8: "0" }),
    );
    expect(res.status).toBe(400);
    expect(getQuote).not.toHaveBeenCalled();
  });

  it("400 for a NEGATIVE merchantId", async () => {
    const res = await GET(
      reqUrl({ chainId: String(ARC), merchantId: "-1", token: TOKEN, usdAmount8: "2900000000" }),
    );
    expect(res.status).toBe(400);
    expect(getQuote).not.toHaveBeenCalled();
  });
});

describe("GET /api/quote — error surfacing", () => {
  it("500 (LOUD) when the router address is not configured — never a silent 200", async () => {
    getRouterAddress.mockImplementation(() => {
      throw new Error("No router address configured for chain 5042002");
    });
    const res = await GET(
      reqUrl({ chainId: String(ARC), merchantId: "42", token: TOKEN, usdAmount8: "2900000000" }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("No router address configured");
  });

  it("surfaces the on-chain revert NAME (e.g. stale price) so checkout shows an honest error", async () => {
    const reverted = new ContractFunctionRevertedError({
      abi: [],
      functionName: "quote",
    });
    // viem derives its own `data` from the abi; force the custom-error name the
    // route reads (`revert.data?.errorName`) so we assert the real extraction path.
    (reverted as unknown as { data?: { errorName: string } }).data = {
      errorName: "OracleLib__StalePrice",
    };
    const baseErr = new BaseError("reverted");
    // Make `.walk()` find the reverted error the route looks for.
    (baseErr as unknown as { walk: (fn: (e: unknown) => boolean) => unknown }).walk = (
      fn: (e: unknown) => boolean,
    ) => (fn(reverted) ? reverted : baseErr);
    getQuote.mockRejectedValue(baseErr);

    const res = await GET(
      reqUrl({ chainId: String(ARC), merchantId: "42", token: TOKEN, usdAmount8: "2900000000" }),
    );
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("OracleLib__StalePrice");
  });
});
