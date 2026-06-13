/**
 * @file erc7715.test.ts — the ERC-7715 / ERC-7710 interop adapter contract.
 *
 * Pins the off-chain seam: a sample ERC-7715 spend-permission request maps onto the exact
 * SessionGrant.openSessionFor params, the opaque 7715 `context` round-trips through
 * encode/decode, and the ERC-7710 redemption descriptor points at SessionGrant.spend. Pure,
 * deterministic, no network — the on-chain money path is untouched (the 7710 router facade is deferred).
 */
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  type Erc7715Request,
  SUPPORTED_PERMISSION_TYPES,
  buildRedemptionDescriptor,
  decodeContext,
  encodeContext,
  extractAllowance,
  grantToSessionParams,
} from "../lib/erc7715/permissions.js";

/** A representative ERC-7715 request: 100 USDC (6dp → 100_000000 base units) periodic allowance on Arc. */
const REQUEST: Erc7715Request = {
  chainId: 5042002,
  account: "0x1111111111111111111111111111111111111111",
  signer: "0x2222222222222222222222222222222222222222",
  expiry: 4_000_000_000,
  nonce: 0,
  permission: {
    type: "erc20-token-periodic",
    data: {
      token: "0x3600000000000000000000000000000000000000",
      amount: "100000000",
    },
  },
};

const SESSION_GRANT = "0x4444444444444444444444444444444444444444" as const;
const SESSION_ID =
  "0xaaaa000000000000000000000000000000000000000000000000000000000001" as const;

describe("grantToSessionParams — ERC-7715 request → SessionGrant.openSessionFor params", () => {
  it("maps the sample grant onto the exact openSessionFor params", () => {
    const params = grantToSessionParams(REQUEST);
    // owner ← account, delegate ← signer (both checksummed)
    expect(params.owner).toBe("0x1111111111111111111111111111111111111111");
    expect(params.delegate).toBe("0x2222222222222222222222222222222222222222");
    // budgetCap ← the 7715 allowance/amount (uint256 decimal string, never a JS number)
    expect(params.budgetCap).toBe("100000000");
    // expiry + nonce + chainId pass through unchanged
    expect(params.expiry).toBe(4_000_000_000);
    expect(params.nonce).toBe(0);
    expect(params.chainId).toBe(5042002);
    // token is interop metadata (checksummed), permissionType is the audit trail
    expect(params.token).toBe("0x3600000000000000000000000000000000000000");
    expect(params.permissionType).toBe("erc20-token-periodic");
  });

  it("defaults nonce to 0 when the request omits it", () => {
    const { nonce: _omit, ...noNonce } = REQUEST;
    const params = grantToSessionParams(noNonce);
    expect(params.nonce).toBe(0);
  });

  it("checksums lowercase input addresses (account, signer, token)", () => {
    const account = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
    const signer = "0x000000000000000000000000000000000000dead" as const;
    const params = grantToSessionParams({ ...REQUEST, account, signer });
    // EIP-55 checksummed (match viem's own getAddress rather than a brittle hand-typed literal)
    expect(params.owner).toBe(getAddress(account));
    expect(params.delegate).toBe(getAddress(signer));
    expect(params.owner).not.toBe(account); // proves the checksum actually changed the casing
  });

  it("carries no token (null) for a native-token permission", () => {
    const params = grantToSessionParams({
      ...REQUEST,
      permission: { type: "native-token-stream", data: { allowance: "500" } },
    });
    expect(params.token).toBeNull();
    expect(params.budgetCap).toBe("500");
    expect(params.permissionType).toBe("native-token-stream");
  });

  it("accepts every supported permission type", () => {
    for (const type of SUPPORTED_PERMISSION_TYPES) {
      const data = type.startsWith("erc20")
        ? { token: REQUEST.permission.data.token, amount: "1" }
        : { amount: "1" };
      expect(() => grantToSessionParams({ ...REQUEST, permission: { type, data } })).not.toThrow();
    }
  });

  it("rejects an unsupported permission type (law #4 — never silently coerce)", () => {
    expect(() =>
      grantToSessionParams({ ...REQUEST, permission: { type: "nft-transfer", data: { amount: "1" } } }),
    ).toThrow(/unsupported permission type/);
  });

  it("rejects a zero allowance (maps to SessionGrant__ZeroBudget)", () => {
    expect(() =>
      grantToSessionParams({ ...REQUEST, permission: { type: "native-token-stream", data: { allowance: "0" } } }),
    ).toThrow(/zero/);
  });

  it("rejects an erc20 permission missing a valid token", () => {
    expect(() =>
      grantToSessionParams({ ...REQUEST, permission: { type: "erc20-token-stream", data: { allowance: "1" } } }),
    ).toThrow(/erc20 permission requires a valid data.token/);
  });

  it("rejects a non-positive expiry", () => {
    expect(() => grantToSessionParams({ ...REQUEST, expiry: 0 })).toThrow(/expiry/);
  });

  it("rejects an invalid signer address", () => {
    expect(() => grantToSessionParams({ ...REQUEST, signer: "0xnotanaddress" as `0x${string}` })).toThrow(
      /invalid signer/,
    );
  });

  it("is deterministic for the same input", () => {
    expect(grantToSessionParams(REQUEST)).toEqual(grantToSessionParams(REQUEST));
  });
});

describe("extractAllowance — accepts allowance / amount / periodAmount", () => {
  it("reads `allowance` (stream shape)", () => {
    expect(extractAllowance({ allowance: "42" })).toBe("42");
  });
  it("reads `amount` (periodic shape)", () => {
    expect(extractAllowance({ amount: "43" })).toBe("43");
  });
  it("reads `periodAmount` (alternate periodic shape)", () => {
    expect(extractAllowance({ periodAmount: "44" })).toBe("44");
  });
  it("throws when no allowance key is present", () => {
    expect(() => extractAllowance({})).toThrow(/no allowance/);
  });
  it("throws on a non-integer allowance", () => {
    expect(() => extractAllowance({ allowance: "1.5" })).toThrow(/integer string/);
  });
});

describe("encodeContext / decodeContext — opaque 7715 context round-trip", () => {
  it("round-trips (sessionGrant, sessionId) exactly", () => {
    const context = encodeContext(SESSION_GRANT, SESSION_ID);
    const decoded = decodeContext(context);
    expect(decoded.sessionGrant).toBe(SESSION_GRANT);
    expect(decoded.sessionId).toBe(SESSION_ID);
  });

  it("encodes a deterministic 0x-hex blob", () => {
    const a = encodeContext(SESSION_GRANT, SESSION_ID);
    const b = encodeContext(SESSION_GRANT, SESSION_ID);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]+$/);
  });

  it("returns the SessionGrant address checksummed even from lowercase input", () => {
    const lower = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
    const decoded = decodeContext(encodeContext(lower, SESSION_ID));
    expect(decoded.sessionGrant).toBe(getAddress(lower));
    expect(decoded.sessionGrant).not.toBe(lower); // checksum actually applied
  });

  it("rejects an invalid SessionGrant address", () => {
    expect(() => encodeContext("0xnope" as `0x${string}`, SESSION_ID)).toThrow(/invalid SessionGrant/);
  });

  it("rejects a sessionId that is not 32-byte hex", () => {
    expect(() => encodeContext(SESSION_GRANT, "0x1234" as `0x${string}`)).toThrow(/32-byte hex/);
  });
});

describe("buildRedemptionDescriptor — ERC-7710 redeemDelegations → SessionGrant.spend", () => {
  it("decodes the context and points the redemption at SessionGrant.spend", () => {
    const context = encodeContext(SESSION_GRANT, SESSION_ID);
    const descriptor = buildRedemptionDescriptor(context, "25000000");
    expect(descriptor.permissionContext).toBe(context);
    expect(descriptor.target).toBe(SESSION_GRANT);
    expect(descriptor.sessionId).toBe(SESSION_ID);
    expect(descriptor.method).toBe("spend");
    expect(descriptor.amount).toBe("25000000");
    expect(descriptor.call).toEqual({ sessionId: SESSION_ID, amount: "25000000" });
  });

  it("rejects a zero amount (maps to SessionGrant__ZeroAmount)", () => {
    const context = encodeContext(SESSION_GRANT, SESSION_ID);
    expect(() => buildRedemptionDescriptor(context, "0")).toThrow(/zero spend amount/);
  });

  it("rejects a non-integer amount", () => {
    const context = encodeContext(SESSION_GRANT, SESSION_ID);
    expect(() => buildRedemptionDescriptor(context, "1.5")).toThrow(/integer string/);
  });
});

describe("end-to-end: 7715 grant → context → 7710 redemption (off-chain seam)", () => {
  it("flows a granted permission all the way to a spend descriptor", () => {
    // 1. Wallet grants a 7715 permission → SessionGrant.openSessionFor params.
    const params = grantToSessionParams(REQUEST);
    expect(params.budgetCap).toBe("100000000");

    // 2. After openSessionFor returns a sessionId, the app gets the opaque 7715 context.
    const context = encodeContext(SESSION_GRANT, SESSION_ID);

    // 3. A 7710-aware delegate redeems within budget against the SAME SessionGrant + session.
    const descriptor = buildRedemptionDescriptor(context, "40000000");
    expect(descriptor.target).toBe(SESSION_GRANT);
    expect(descriptor.sessionId).toBe(SESSION_ID);
    expect(descriptor.method).toBe("spend");
    expect(BigInt(descriptor.amount) <= BigInt(params.budgetCap)).toBe(true);
  });
});
