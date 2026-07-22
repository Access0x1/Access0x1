/**
 * @file challenge.ts — x402 402-challenge discovery + the malformed-challenge guard.
 */

import { MalformedChallengeError } from "./errors.js";
import type { PaymentChallenge, PaymentRequirement } from "./types.js";

/**
 * Parse and validate an x402 402 response body into a {@link PaymentChallenge}.
 *
 * Discovery rule (x402 v1): a genuine challenge is a JSON object carrying a non-empty
 * `accepts` array of objects. Anything else — a plain-text 402, an empty or missing
 * `accepts`, a non-object body, a non-object `accepts` entry — is rejected with
 * {@link MalformedChallengeError}. This is the guard that stops the payer from settling
 * a 402 it cannot recognize (e.g. a generic "402 Payment Required" from an unrelated
 * server): a malformed challenge NEVER reaches the rail.
 *
 * @param body - the parsed 402 response body (a JSON value, or a string if not JSON).
 * @returns the validated challenge.
 * @throws {MalformedChallengeError} when `body` is not a valid x402 challenge.
 */
export function parseChallenge(body: unknown): PaymentChallenge {
  if (typeof body !== "object" || body === null) {
    throw new MalformedChallengeError("402 body is not a JSON object", body);
  }
  const b = body as Record<string, unknown>;
  const accepts = b.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new MalformedChallengeError("402 body has no non-empty `accepts` array", body);
  }
  for (const entry of accepts) {
    if (typeof entry !== "object" || entry === null) {
      throw new MalformedChallengeError("`accepts` contains a non-object entry", body);
    }
  }
  const x402Version = typeof b.x402Version === "number" ? b.x402Version : undefined;
  const error = typeof b.error === "string" ? b.error : undefined;
  return {
    x402Version,
    accepts: accepts as readonly PaymentRequirement[],
    error,
    raw: body,
  };
}
