import { describe, it, expect, vi, beforeEach } from "vitest";

// The route imports payoutService/privateWithdraw which import the SDK — mock it.
vi.mock("@unlink-xyz/sdk", () => ({
  createUnlinkAdmin: vi.fn(),
  createUnlinkClient: vi.fn(),
}));

import { handlePayout, type PayoutDeps } from "../app/api/payout/route.js";
import { TenantAuthError } from "../lib/branding/tenant.js";
import {
  ShieldFailedError,
  WithdrawFailedError,
} from "../lib/unlink/privateWithdraw.js";
import { UnlinkSdkUnavailableError } from "../lib/unlink/loadSdk.js";

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
    // Default resolver: identity comes from the "verified" token; a mismatching
    // body userId is rejected. Tests override this to exercise auth outcomes.
    resolveVerifiedUserId: vi.fn(async (_req: Request, body: unknown) => {
      const bodyUserId =
        body && typeof body === "object" && "userId" in body
          ? (body as { userId?: unknown }).userId
          : undefined;
      const verified = USER_ID;
      if (typeof bodyUserId === "string" && bodyUserId.trim() && bodyUserId !== verified) {
        throw new TenantAuthError("Signed-in identity does not match the requested user.");
      }
      return { userId: verified, verified: true };
    }),
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

  // ── IDOR guard: identity comes from the VERIFIED JWT, never the body ─────────

  it("401 when a body userId differs from the verified JWT sub (IDOR rejected)", async () => {
    const { deps } = makeDeps();
    const res = await handlePayout(
      req({
        amountUsd: 4.2,
        depositAmountUsd: 50,
        destination: VALID_DEST,
        // Attacker asserts SOMEONE ELSE's id in the body.
        userId: "dyn|sub-VICTIM",
      }),
      deps,
    );
    expect(res.status).toBe(401);
    // No funds path was entered.
    expect(deps.ensureRegistered).not.toHaveBeenCalled();
    expect(deps.shieldAndWithdraw).not.toHaveBeenCalled();
  });

  it("403 when a verified NON-OWNER session tries to redirect the merchant payout (drain)", async () => {
    // The payout account owner is configured via env; the funds are the MERCHANT's.
    // A different verified session (any signed-in buyer) must not move them — even
    // though it is authenticated — or it could withdraw to its own address.
    process.env.UNLINK_PAYOUT_USER_ID = USER_ID; // the merchant owns the payout account
    try {
      const { deps } = makeDeps({
        // A totally different verified user — an ordinary buyer, not the merchant.
        resolveVerifiedUserId: vi.fn(async () => ({ userId: "dyn|sub-RANDOM-BUYER", verified: true })),
      });
      const res = await handlePayout(
        req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST }),
        deps,
      );
      expect(res.status).toBe(403);
      // No funds path was entered.
      expect(deps.ensureRegistered).not.toHaveBeenCalled();
      expect(deps.shieldAndWithdraw).not.toHaveBeenCalled();
    } finally {
      delete process.env.UNLINK_PAYOUT_USER_ID;
    }
  });

  it("200 when the verified OWNER (userId == the configured payout id) withdraws", async () => {
    process.env.UNLINK_PAYOUT_USER_ID = USER_ID;
    try {
      const { deps } = makeDeps();
      const res = await handlePayout(
        req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
        deps,
      );
      expect(res.status).toBe(200);
      expect(deps.shieldAndWithdraw).toHaveBeenCalled();
    } finally {
      delete process.env.UNLINK_PAYOUT_USER_ID;
    }
  });

  it("401 when identity resolution fails (no/invalid token)", async () => {
    const { deps } = makeDeps({
      resolveVerifiedUserId: vi.fn(async () => {
        throw new TenantAuthError();
      }),
    });
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(401);
    expect(deps.ensureRegistered).not.toHaveBeenCalled();
    expect(deps.shieldAndWithdraw).not.toHaveBeenCalled();
  });

  it("401 when the caller is not cryptographically verified (booth fallback — money-path fail-closed)", async () => {
    // The resolver's booth-gated fallback (Dynamic env unset) returns verified:false
    // after only shape-checking the body. For a WITHDRAW that is not good enough —
    // the route must fail closed rather than trust a body-derived id.
    const { deps } = makeDeps({
      resolveVerifiedUserId: vi.fn(async () => ({ userId: USER_ID, verified: false })),
    });
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(401);
    expect(deps.ensureRegistered).not.toHaveBeenCalled();
    expect(deps.shieldAndWithdraw).not.toHaveBeenCalled();
  });

  it("uses the VERIFIED sub for ensureRegistered, not any body userId", async () => {
    const resolveVerifiedUserId = vi.fn(async () => ({
      userId: "dyn|sub-VERIFIED",
      verified: true,
    }));
    const { deps } = makeDeps({ resolveVerifiedUserId });
    // Body omits userId entirely — the verified sub is what drives the path.
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(deps.ensureRegistered).toHaveBeenCalledWith("dyn|sub-VERIFIED");
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

  it("SDK absent during register -> 503 { code: 'unlink_sdk_unavailable', recoverable: true }", async () => {
    const { deps } = makeDeps({
      ensureRegistered: vi.fn(async () => {
        throw new UnlinkSdkUnavailableError();
      }),
    });
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ code: "unlink_sdk_unavailable", recoverable: true });
  });

  it("SDK absent during shield+withdraw -> 503 { code: 'unlink_sdk_unavailable', recoverable: true }", async () => {
    const { deps } = makeDeps({
      shieldAndWithdraw: vi.fn(async () => {
        throw new UnlinkSdkUnavailableError();
      }),
    });
    const res = await handlePayout(
      req({ amountUsd: 4.2, depositAmountUsd: 50, destination: VALID_DEST, userId: USER_ID }),
      deps,
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ code: "unlink_sdk_unavailable", recoverable: true });
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
