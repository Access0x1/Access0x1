/**
 * @file x402.adversarial.test.ts — replay / amount-mismatch / authoritative-amount
 * coverage for the x402 seller spine (lib/x402.ts withGateway).
 *
 * The facilitator (Circle's BatchFacilitatorClient) is the on-chain authority that
 * rejects a replayed EIP-3009 nonce or an authorization whose amount does not match
 * the requirement. From the SELLER side, the web invariants we MUST guarantee are:
 *   - a facilitator `verify` rejection (replay / amount mismatch / expired auth) maps
 *     to 402 and the handler NEVER runs and NOTHING is recorded to the ledger,
 *   - the amount charged + recorded + echoed comes from the SERVER's requirement,
 *     never from the (attacker-controllable) signed payload — so a payload claiming a
 *     smaller amount cannot make the seller deliver for less (law #4),
 *   - settle is never reached when verify rejects (strict CEI ordering).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.SELLER_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const verify = vi.fn();
const settle = vi.fn();

vi.mock("@circle-fin/x402-batching/server", () => ({
  BatchFacilitatorClient: class {
    verify = verify;
    settle = settle;
  },
}));

const { withGateway } = await import("../../lib/x402.js");
const { __resetLedger, recentPayments } = await import("../../lib/payment-ledger.js");

function sigHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

beforeEach(() => {
  verify.mockReset();
  settle.mockReset();
  __resetLedger();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("withGateway — replay / amount-mismatch rejection", () => {
  it("a replayed authorization (verify invalidReason='nonce_already_used') -> 402, no settle, no record", async () => {
    verify.mockResolvedValue({ isValid: false, invalidReason: "nonce_already_used" });
    const handler = vi.fn(async () => Response.json({ secret: "data" }));
    const h = withGateway(handler, "$0.01", "/api/premium/dataset");
    const res = await h(
      new Request("https://x/api/premium/dataset", {
        headers: { "payment-signature": sigHeader({ x402Version: 1, payload: { sig: "0xREPLAY" } }) },
      }),
    );
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toBe("nonce_already_used");
    expect(settle).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(recentPayments()).toHaveLength(0);
  });

  it("an amount-mismatch authorization (verify invalidReason='invalid_exact_value') -> 402, handler never runs", async () => {
    verify.mockResolvedValue({ isValid: false, invalidReason: "invalid_exact_value" });
    const handler = vi.fn(async () => Response.json({ secret: "data" }));
    const h = withGateway(handler, "$0.03", "/api/premium/compute");
    const res = await h(
      new Request("https://x/api/premium/compute", {
        method: "POST",
        headers: { "payment-signature": sigHeader({ x402Version: 1, payload: { value: "1" } }) },
      }),
    );
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toBe("invalid_exact_value");
    expect(handler).not.toHaveBeenCalled();
    expect(recentPayments()).toHaveLength(0);
  });

  it("an expired authorization (verify invalidReason='authorization_expired') -> 402", async () => {
    verify.mockResolvedValue({ isValid: false, invalidReason: "authorization_expired" });
    const h = withGateway(async () => Response.json({ ok: true }), "$0.01", "/api/premium/dataset");
    const res = await h(
      new Request("https://x/api/premium/dataset", {
        headers: { "payment-signature": sigHeader({ x402Version: 1, payload: {} }) },
      }),
    );
    expect(res.status).toBe(402);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("withGateway — server is authoritative on amount", () => {
  it("records + echoes the SERVER requirement amount, NOT a smaller amount claimed in the payload", async () => {
    verify.mockResolvedValue({ isValid: true, payer: "0xPAYER" });
    settle.mockResolvedValue({
      success: true,
      payer: "0xPAYER",
      transaction: "0xBATCH",
      network: "eip155:5042002",
    });
    const h = withGateway(async () => Response.json({ ok: true }), "$0.03", "/api/premium/compute");

    // Attacker signs a payload that claims a far smaller value than the $0.03 price.
    const res = await h(
      new Request("https://x/api/premium/compute", {
        method: "POST",
        headers: {
          "payment-signature": sigHeader({
            x402Version: 1,
            payload: { authorization: { value: "1" } }, // 0.000001 USDC — lie
          }),
        },
      }),
    );
    expect(res.status).toBe(200);

    // The requirement passed to verify/settle carries the SERVER amount (30000 = $0.03).
    const reqArg = verify.mock.calls[0][1] as { amount: string };
    expect(reqArg.amount).toBe("30000");
    const settleReqArg = settle.mock.calls[0][1] as { amount: string };
    expect(settleReqArg.amount).toBe("30000");

    // The ledger + echoed PAYMENT-RESPONSE reflect the server price, not the payload lie.
    const recorded = recentPayments();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].amountUsdc).toBe("0.03");
    const echoed = decode(res.headers.get("PAYMENT-RESPONSE") as string) as { transaction: string };
    expect(echoed.transaction).toBe("0xBATCH");
  });
});
