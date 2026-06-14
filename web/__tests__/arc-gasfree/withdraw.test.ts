/**
 * Tests for POST /api/gateway/withdraw.
 *
 * Auth is mocked via vi.mock('@/lib/branding/tenant'):
 *  - Authorization: Bearer valid-seller  → resolves as SELLER_ADDRESS wallet
 *  - Authorization: Bearer other-wallet  → resolves as a DIFFERENT wallet
 *  - no Authorization header             → throws TenantAuthError (401)
 *
 * The existing business-logic tests (balance, gas, chain validation) use
 * authedReq() so they still pass through auth and exercise the gateway logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── SELLER_ADDRESS must be set before the route module is imported ────────────
const SELLER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.SELLER_ADDRESS = SELLER;

// ── Mock the Dynamic/tenant auth seam ────────────────────────────────────────
vi.mock("@/lib/branding/tenant.js", () => {
  const TenantAuthError = class extends Error {
    constructor(msg = "Sign in to save your branding.") {
      super(msg);
      this.name = "TenantAuthError";
    }
  };
  return {
    TenantAuthError,
    resolveVerifiedTenant: vi.fn(async (req: Request) => {
      const auth = req.headers.get("authorization") ?? "";
      if (auth === `Bearer valid-seller`) {
        return { tenantId: SELLER, verified: true };
      }
      if (auth.startsWith("Bearer other-")) {
        return {
          tenantId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          verified: true,
        };
      }
      throw new TenantAuthError("Sign in to save your branding.");
    }),
  };
});

import {
  __setWithdrawClientFactory,
  POST,
  type WithdrawClient,
} from "../../app/api/gateway/withdraw/route.js";

const RECIPIENT = "0x1111111111111111111111111111111111111111";

/** Build a POST request WITHOUT auth (anonymous). */
function anonReq(body: unknown): Request {
  return new Request("https://x/api/gateway/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Build a POST request authenticated as the seller. */
function authedReq(body: unknown): Request {
  return new Request("https://x/api/gateway/withdraw", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer valid-seller",
    },
    body: JSON.stringify(body),
  });
}

/** Build a POST request authenticated as a DIFFERENT wallet (not seller). */
function otherWalletReq(body: unknown): Request {
  return new Request("https://x/api/gateway/withdraw", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer other-wallet",
    },
    body: JSON.stringify(body),
  });
}

function mockClient(over: Partial<WithdrawClient> = {}): WithdrawClient {
  return {
    getBalances: vi.fn(async () => ({
      gateway: { formattedAvailable: "10.000000" },
    })),
    withdraw: vi.fn(async () => ({ mintTxHash: "0xMINT" })),
    ...over,
  };
}

beforeEach(() => {
  process.env.SELLER_ADDRESS = SELLER;
});

afterEach(() => {
  __setWithdrawClientFactory(null);
  vi.restoreAllMocks();
});

// ── Auth hardening tests ──────────────────────────────────────────────────────

describe("POST /api/gateway/withdraw — auth hardening", () => {
  it("anonymous request (no Authorization header) → 401", async () => {
    __setWithdrawClientFactory(() => mockClient());
    const res = await POST(
      anonReq({ amount: "1.00", destinationChain: "arcTestnet", recipient: RECIPIENT }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("caller wallet does not match SELLER_ADDRESS → 403", async () => {
    __setWithdrawClientFactory(() => mockClient());
    const res = await POST(
      otherWalletReq({ amount: "1.00", destinationChain: "arcTestnet", recipient: RECIPIENT }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/forbidden/i);
  });

  it("anonymous request does NOT call the gateway client (no side-effect)", async () => {
    const client = mockClient();
    __setWithdrawClientFactory(() => client);
    await POST(anonReq({ amount: "1.00", destinationChain: "arcTestnet", recipient: RECIPIENT }));
    expect(client.withdraw).not.toHaveBeenCalled();
    expect(client.getBalances).not.toHaveBeenCalled();
  });
});

// ── Business-logic tests (pass auth as the seller) ────────────────────────────

describe("POST /api/gateway/withdraw (stub)", () => {
  it("unsupported destinationChain → 400 'unsupported chain'", async () => {
    __setWithdrawClientFactory(() => mockClient());
    const res = await POST(
      authedReq({
        amount: "1.00",
        destinationChain: "notachain",
        recipient: RECIPIENT,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported chain" });
  });

  it("available < amount → 400 'insufficient balance'", async () => {
    __setWithdrawClientFactory(() =>
      mockClient({
        getBalances: vi.fn(async () => ({
          gateway: { formattedAvailable: "0.50" },
        })),
      }),
    );
    const res = await POST(
      authedReq({
        amount: "1.00",
        destinationChain: "arcTestnet",
        recipient: RECIPIENT,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "insufficient balance" });
  });

  it("gas error from withdraw → 400 translated message (not raw)", async () => {
    __setWithdrawClientFactory(() =>
      mockClient({
        withdraw: vi.fn(async () => {
          throw new Error("insufficient funds for gas * price + value");
        }),
      }),
    );
    const res = await POST(
      authedReq({
        amount: "1.00",
        destinationChain: "arcTestnet",
        recipient: RECIPIENT,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Arc gas/);
    expect(body.error).not.toMatch(/insufficient funds for gas \* price/);
  });

  it("happy path → 200 { mintTxHash }", async () => {
    const client = mockClient();
    __setWithdrawClientFactory(() => client);
    const res = await POST(
      authedReq({
        amount: "1.00",
        destinationChain: "arcTestnet",
        recipient: RECIPIENT,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mintTxHash: "0xMINT" });
    expect(client.withdraw).toHaveBeenCalledWith("1.00", {
      chain: "arcTestnet",
      recipient: RECIPIENT,
    });
  });

  it("invalid amount → 400", async () => {
    __setWithdrawClientFactory(() => mockClient());
    const res = await POST(
      authedReq({
        amount: "0",
        destinationChain: "arcTestnet",
        recipient: RECIPIENT,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid amount" });
  });
});
