import { describe, expect, it } from "vitest";
import { MalformedChallengeError, parseChallenge } from "../src/index.js";

describe("parseChallenge", () => {
  it("accepts a valid x402 challenge with a non-empty accepts array", () => {
    const body = {
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "10000",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          resource: "https://api.example.com/premium",
        },
      ],
    };
    const challenge = parseChallenge(body);
    expect(challenge.x402Version).toBe(1);
    expect(challenge.error).toBe("X-PAYMENT header is required");
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]?.scheme).toBe("exact");
    expect(challenge.raw).toBe(body);
  });

  it("rejects a body with no accepts field", () => {
    expect(() => parseChallenge({ error: "please pay" })).toThrow(MalformedChallengeError);
  });

  it("rejects an empty accepts array", () => {
    expect(() => parseChallenge({ accepts: [] })).toThrow(MalformedChallengeError);
  });

  it("rejects a non-object accepts entry", () => {
    expect(() => parseChallenge({ accepts: ["not-an-object"] })).toThrow(MalformedChallengeError);
  });

  it("rejects a plain-text body", () => {
    expect(() => parseChallenge("402 Payment Required")).toThrow(MalformedChallengeError);
  });

  it("rejects null", () => {
    expect(() => parseChallenge(null)).toThrow(MalformedChallengeError);
  });

  it("preserves the raw body on the error for diagnostics", () => {
    try {
      parseChallenge({ nope: true });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedChallengeError);
      expect((err as MalformedChallengeError).body).toEqual({ nope: true });
    }
  });
});
