import { describe, it, expect, vi, beforeEach } from "vitest";

// The route imports payoutService/privateWithdraw which import the SDK — mock it.
vi.mock("@unlink-xyz/sdk", () => ({
  createUnlinkAdmin: vi.fn(),
  createUnlinkClient: vi.fn(),
}));

import { handlePayout, type PayoutDeps } from "../app/api/payout/route.js";
import {
  ShieldFailedError,
  WithdrawFailedError,
} from "../lib/unlink/privateWithdraw.js";

const VALID_DEST = "0x2222222222222222222222222222222222222222";
const USER_ID = "dyn|sub-abc";

function req(body: unknown): Request {
  return new Request("http://localhost/api/payout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeps(overrides?: Partial<PayoutDeps>): { deps: PayoutDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: PayoutDeps = {
    ensureRegistered: vi.fn(async () => {
      calls.push("ensureRegistered");
    }),
    shieldAndWithdraw: vi.fn(async () => {
      calls.push("shieldAndWithdraw");
      return { depositTx: "0xdeposit", withdrawTx: "0xwithdraw" };
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("POST /api/payout (handlePayout)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("400 when amountUsd <= 0", async () => {
    const { deps } = makeDeps();
    const res = await handlePayout(
      req({ amountUsd: 0, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(400);
  });

  it("400 when depositAmountUsd <= amountUsd (asymmetry/hygiene)", async () => {
    const { deps } = makeDeps();
    const res = await handlePayout(
      req({ amountUsd: 50, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(400);
  });

  it("400 when destination is not a valid 0x address", async () => {
    const { deps } = makeDeps();
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: "not-an-address", userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(400);
  });

  it("400 when userId is missing", async () => {
    const { deps } = makeDeps();
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST }),
      deps,
    );
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON body", async () => {
    const { deps } = makeDeps();
    const bad = new Request("http://localhost/api/payout", {
      method: "POST",
      body: "{not json",
    });
    const res = await handlePayout(bad, deps);
    expect(res.status).toBe(400);
  });

  it("happy path -> 200 { depositTx, withdrawTx }", async () => {
    const { deps } = makeDeps();
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ depositTx: "0xdeposit", withdrawTx: "0xwithdraw" });
  });

  it("calls ensureRegistered BEFORE shieldAndWithdraw", async () => {
    const { deps, calls } = makeDeps();
    await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(calls).toEqual(["ensureRegistered", "shieldAndWithdraw"]);
  });

  it("converts USD floats to base units passed to shieldAndWithdraw", async () => {
    const { deps } = makeDeps();
    await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(deps.shieldAndWithdraw).toHaveBeenCalledWith({
      depositAmountUsdc: 50_000_000,
      withdrawAmountUsdc: 4_200_000,
      destination: VALID_DEST,
    });
  });

  it("shield failure -> 502 { code: 'shield_failed' }", async () => {
    const { deps } = makeDeps({
      shieldAndWithdraw: vi.fn(async () => {
        throw new ShieldFailedError();
      }),
    });
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ code: "shield_failed" });
  });

  it("withdraw failure -> 502 { code: 'withdraw_failed', recoverable: true }", async () => {
    const { deps } = makeDeps({
      shieldAndWithdraw: vi.fn(async () => {
        throw new WithdrawFailedError("0xdeposit");
      }),
    });
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ code: "withdraw_failed", recoverable: true });
  });

  it("unexpected error -> 500", async () => {
    const { deps } = makeDeps({
      shieldAndWithdraw: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(500);
  });

  it("no Unlink API key appears in any response body", async () => {
    process.env.UNLINK_API_KEY = "sk_test_secret_should_never_leak";
    const { deps } = makeDeps({
      shieldAndWithdraw: vi.fn(async () => {
        throw new WithdrawFailedError("0xdeposit");
      }),
    });
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    const text = await res.text();
    expect(text).not.toMatch(/sk_test_secret/);
    delete process.env.UNLINK_API_KEY;
  });
});
