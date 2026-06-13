import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __setWithdrawClientFactory,
  POST,
  type WithdrawClient,
} from "../../app/api/gateway/withdraw/route.js";

const RECIPIENT = "0x1111111111111111111111111111111111111111";

function postReq(body: unknown): Request {
  return new Request("https://x/api/gateway/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json" },
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

afterEach(() => {
  __setWithdrawClientFactory(null);
  vi.restoreAllMocks();
});

describe("POST /api/gateway/withdraw (stub)", () => {
  it("unsupported destinationChain → 400 'unsupported chain'", async () => {
    __setWithdrawClientFactory(() => mockClient());
    const res = await POST(
      postReq({
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
      postReq({
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
      postReq({
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
      postReq({
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
      postReq({
        amount: "0",
        destinationChain: "arcTestnet",
        recipient: RECIPIENT,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid amount" });
  });
});
