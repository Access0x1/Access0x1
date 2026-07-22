import { describe, expect, it } from "vitest";
import {
  Access0x1Payer,
  BudgetExceededError,
  HumanGateRequiredError,
  MalformedChallengeError,
  PaymentRailError,
  PaymentUnresolvedError,
  type PaymentChallenge,
} from "../src/index.js";
import { headerValue, jsonResponse, mockFetch, parseInitBody } from "./helpers.js";

const RESOURCE = "https://api.example.com/premium";
const BASE = "https://pay.example.com";
const PAY_URL = `${BASE}/api/agent/pay`;

/** A well-formed x402 v1 challenge body (matches the spec example). */
const CHALLENGE = {
  x402Version: 1,
  error: "X-PAYMENT header is required",
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      resource: RESOURCE,
      description: "Premium data",
      maxTimeoutSeconds: 60,
    },
  ],
};

describe("Access0x1Payer.fetch", () => {
  it("402 → pay → retry happy path: discovers, settles, returns the paid result", async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url === RESOURCE) return jsonResponse(402, CHALLENGE);
      if (url === PAY_URL) {
        return jsonResponse(200, { ok: true, result: { data: "premium-payload" }, agent: "0xAgent" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const payer = new Access0x1Payer({ baseUrl: BASE, callerAuth: "s3cret", fetchImpl });

    const out = await payer.fetch<{ data: string }>(RESOURCE);

    expect(out.paid).toBe(true);
    expect(out.status).toBe(200);
    expect(out.result).toEqual({ data: "premium-payload" });
    expect(out.agent).toBe("0xAgent");
    expect(out.challenge?.accepts[0]?.network).toBe("base-sepolia");

    // Probe first, then settle — exactly two calls, in order.
    expect(calls.map((c) => c.url)).toEqual([RESOURCE, PAY_URL]);
    // The rail body carries only the real endpoint field `url` — nothing invented.
    expect(parseInitBody(calls[1]?.init)).toEqual({ url: RESOURCE });
    // Caller-auth is attached as x-internal-secret.
    expect(headerValue(calls[1]?.init, "x-internal-secret")).toBe("s3cret");
  });

  it("surfaces an insufficient-budget rejection — never swallowed", async () => {
    const { fetchImpl } = mockFetch((url) => {
      if (url === RESOURCE) return jsonResponse(402, CHALLENGE);
      if (url === PAY_URL) return jsonResponse(402, { error: "BudgetExceeded", spent: 5, cap: 5 });
      throw new Error(`unexpected url ${url}`);
    });
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });

    await expect(payer.fetch(RESOURCE)).rejects.toBeInstanceOf(BudgetExceededError);

    // Confirm the rail's numbers are surfaced, not hidden.
    try {
      await payer.fetch(RESOURCE);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).spent).toBe(5);
      expect((err as BudgetExceededError).cap).toBe(5);
    }
  });

  it("guards a malformed 402: refuses to pay and never calls the rail", async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url === RESOURCE) return jsonResponse(402, { message: "please pay" }); // no accepts
      throw new Error(`unexpected url ${url}`);
    });
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });

    await expect(payer.fetch(RESOURCE)).rejects.toBeInstanceOf(MalformedChallengeError);
    expect(calls.map((c) => c.url)).toEqual([RESOURCE]);
  });

  it("passes through a non-402 response unpaid, without calling the rail", async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url === RESOURCE) return jsonResponse(200, { hello: "world" });
      throw new Error(`unexpected url ${url}`);
    });
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });

    const out = await payer.fetch<{ hello: string }>(RESOURCE);
    expect(out.paid).toBe(false);
    expect(out.status).toBe(200);
    expect(out.result).toEqual({ hello: "world" });
    expect(calls.map((c) => c.url)).toEqual([RESOURCE]);
  });

  it("maps a human-gate 402 to HumanGateRequiredError", async () => {
    const { fetchImpl } = mockFetch((url) => {
      if (url === RESOURCE) return jsonResponse(402, CHALLENGE);
      return jsonResponse(402, { error: "HumanGateRequired" });
    });
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });
    await expect(payer.fetch(RESOURCE)).rejects.toBeInstanceOf(HumanGateRequiredError);
  });

  it("maps a 502 PaymentRequiredUnresolved to PaymentUnresolvedError", async () => {
    const { fetchImpl } = mockFetch((url) => {
      if (url === RESOURCE) return jsonResponse(402, CHALLENGE);
      return jsonResponse(502, { error: "PaymentRequiredUnresolved" });
    });
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });
    await expect(payer.fetch(RESOURCE)).rejects.toBeInstanceOf(PaymentUnresolvedError);
  });

  it("omits the caller-auth header when unset, and forwards the per-call price", async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url === RESOURCE) return jsonResponse(402, CHALLENGE);
      return jsonResponse(200, { ok: true, result: { ok: 1 }, agent: "0xA" });
    });
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });

    await payer.fetch(RESOURCE, { pricePerCallUsd: 0.002 });
    expect(headerValue(calls[1]?.init, "x-internal-secret")).toBeUndefined();
    expect(parseInitBody(calls[1]?.init)).toEqual({ url: RESOURCE, pricePerCallUsd: 0.002 });
  });
});

describe("Access0x1Payer.settle", () => {
  it("forwards a nano-loop count and returns the results array", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse(200, { ok: true, results: [{ i: 0 }, { i: 1 }, { i: 2 }], agent: "0xAgent" }),
    );
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });

    const s = await payer.settle<{ i: number }>({ url: RESOURCE, count: 3, pricePerCallUsd: 0.001 });
    expect(s.results).toHaveLength(3);
    expect(s.result).toBeUndefined();
    expect(parseInitBody(calls[0]?.init)).toEqual({ url: RESOURCE, count: 3, pricePerCallUsd: 0.001 });
  });

  it("surfaces a generic rail error with status, code, and detail", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(400, { error: "BadRequest", reason: "url not in allowlist" }),
    );
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });
    try {
      await payer.settle({ url: RESOURCE });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentRailError);
      expect((err as PaymentRailError).status).toBe(400);
      expect((err as PaymentRailError).code).toBe("BadRequest");
      expect((err as PaymentRailError).detail).toBe("url not in allowlist");
    }
  });

  it("refuses to settle a supplied malformed challenge without calling the rail", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { ok: true, result: {} }));
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });

    const malformed = { accepts: [], raw: { accepts: [] } } as unknown as PaymentChallenge;
    await expect(payer.settle({ url: RESOURCE, challenge: malformed })).rejects.toBeInstanceOf(
      MalformedChallengeError,
    );
    expect(calls).toHaveLength(0);
  });

  it("throws a plain Error when url is missing", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(200, { ok: true }));
    const payer = new Access0x1Payer({ baseUrl: BASE, fetchImpl });
    await expect(payer.settle({ url: "" })).rejects.toThrow(/`url` is required/);
  });
});

describe("Access0x1Payer constructor", () => {
  it("requires a baseUrl", () => {
    expect(() => new Access0x1Payer({ baseUrl: "" })).toThrow(/`baseUrl` is required/);
  });

  it("strips a trailing slash from baseUrl so paths join cleanly", async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url === RESOURCE) return jsonResponse(402, CHALLENGE);
      return jsonResponse(200, { ok: true, result: 1 });
    });
    const payer = new Access0x1Payer({ baseUrl: `${BASE}/`, fetchImpl });
    await payer.fetch(RESOURCE);
    expect(calls[1]?.url).toBe(PAY_URL);
  });
});
