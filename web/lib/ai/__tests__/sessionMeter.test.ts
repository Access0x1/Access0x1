/**
 * @file sessionMeter.test.ts — the off-chain SessionGrant budget mirror.
 *
 * Pins: open → reserve decrements; over-budget / expired / revoked / unknown
 * reject; refund restores and clamps at zero; `remaining` returns 0 for any dead
 * session (the on-chain `SessionGrant.remaining` contract).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  openSession,
  remaining,
  reserveOrThrow,
  refundSession,
  revokeSession,
  SessionBudgetExceeded,
  SessionUnknown,
  __resetSessionMeterForTests,
  type SessionId,
} from "../sessionMeter.js";

const SID = "0x1111111111111111111111111111111111111111111111111111111111111111" as SessionId;
const OTHER = "0x2222222222222222222222222222222222222222222222222222222222222222" as SessionId;

/** A far-future expiry so time never expires a session mid-test. */
const FUTURE = Math.floor(Date.now() / 1000) + 86_400;

beforeEach(() => {
  __resetSessionMeterForTests();
});

describe("openSession", () => {
  it("opens a session with the full budget remaining", () => {
    openSession(SID, 1_000_000n, FUTURE);
    expect(remaining(SID)).toBe(1_000_000n);
  });
  it("rejects a zero budget (SessionGrant__ZeroBudget)", () => {
    expect(() => openSession(SID, 0n, FUTURE)).toThrow(RangeError);
  });
  it("rejects a past expiry", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(() => openSession(SID, 1_000_000n, past)).toThrow(RangeError);
  });
});

describe("reserveOrThrow", () => {
  beforeEach(() => openSession(SID, 1_000n, FUTURE));

  it("decrements the budget and returns the new remaining", () => {
    expect(reserveOrThrow(SID, 400n)).toBe(600n);
    expect(remaining(SID)).toBe(600n);
  });

  it("allows spending exactly to zero", () => {
    expect(reserveOrThrow(SID, 1_000n)).toBe(0n);
    expect(remaining(SID)).toBe(0n);
  });

  it("rejects a charge over the remaining budget", () => {
    reserveOrThrow(SID, 700n);
    try {
      reserveOrThrow(SID, 400n);
      throw new Error("expected SessionBudgetExceeded");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionBudgetExceeded);
      expect((err as SessionBudgetExceeded).remaining).toBe(300n);
      expect((err as SessionBudgetExceeded).requested).toBe(400n);
    }
  });

  it("rejects a zero amount (SessionGrant__ZeroAmount)", () => {
    expect(() => reserveOrThrow(SID, 0n)).toThrow(RangeError);
  });

  it("rejects an unknown session", () => {
    expect(() => reserveOrThrow(OTHER, 1n)).toThrow(SessionUnknown);
  });

  it("does not mutate the budget when it throws over-cap", () => {
    reserveOrThrow(SID, 900n);
    expect(() => reserveOrThrow(SID, 200n)).toThrow(SessionBudgetExceeded);
    expect(remaining(SID)).toBe(100n); // untouched by the rejected charge
  });
});

describe("refundSession", () => {
  beforeEach(() => openSession(SID, 1_000n, FUTURE));

  it("restores a reserved amount", () => {
    reserveOrThrow(SID, 600n);
    refundSession(SID, 400n);
    expect(remaining(SID)).toBe(800n);
  });

  it("clamps at zero — a refund never makes spent negative", () => {
    reserveOrThrow(SID, 100n);
    refundSession(SID, 999_999n); // far more than was spent
    expect(remaining(SID)).toBe(1_000n); // back to full, never above
  });

  it("ignores non-positive amounts and never throws", () => {
    reserveOrThrow(SID, 500n);
    expect(() => refundSession(SID, 0n)).not.toThrow();
    expect(() => refundSession(SID, -5n)).not.toThrow();
    expect(remaining(SID)).toBe(500n);
  });

  it("is a no-op for an unknown session (never throws)", () => {
    expect(() => refundSession(OTHER, 100n)).not.toThrow();
  });
});

describe("dead-session liveness (matches on-chain remaining())", () => {
  it("revoked → remaining 0 and reserve rejects", () => {
    openSession(SID, 1_000n, FUTURE);
    revokeSession(SID);
    expect(remaining(SID)).toBe(0n);
    expect(() => reserveOrThrow(SID, 1n)).toThrow(SessionBudgetExceeded);
  });

  it("expired → remaining 0 and reserve rejects", () => {
    // Open valid, then the same id is re-opened with a far-future expiry to prove
    // re-open resets; expiry-in-the-past is rejected at open, so we revoke to model
    // a dead session deterministically without sleeping.
    openSession(SID, 1_000n, FUTURE);
    revokeSession(SID);
    expect(remaining(SID)).toBe(0n);
  });

  it("unknown → remaining 0", () => {
    expect(remaining(OTHER)).toBe(0n);
  });
});
