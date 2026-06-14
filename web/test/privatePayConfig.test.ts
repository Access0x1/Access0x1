import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  isPrivatePayFlagOn,
  isPrivatePayConfigured,
  privatePayStatus,
} from "../lib/unlink/privatePayConfig.js";

function clear(): void {
  delete process.env.UNLINK_PRIVATE_PAY;
  delete process.env.UNLINK_API_KEY;
  delete process.env.ARC_TESTNET_USDC;
}

describe("privatePayConfig", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("flag OFF by default (unset) — status flag_off, not configured", () => {
    expect(isPrivatePayFlagOn()).toBe(false);
    expect(isPrivatePayConfigured()).toBe(false);
    expect(privatePayStatus()).toBe("flag_off");
  });

  it('only the literal "true" turns the flag on (case-insensitive, trimmed)', () => {
    process.env.UNLINK_PRIVATE_PAY = "1";
    expect(isPrivatePayFlagOn()).toBe(false);
    process.env.UNLINK_PRIVATE_PAY = "yes";
    expect(isPrivatePayFlagOn()).toBe(false);
    process.env.UNLINK_PRIVATE_PAY = "  TRUE  ";
    expect(isPrivatePayFlagOn()).toBe(true);
  });

  it("flag on but Unlink env missing => not_configured", () => {
    process.env.UNLINK_PRIVATE_PAY = "true";
    expect(isPrivatePayFlagOn()).toBe(true);
    expect(isPrivatePayConfigured()).toBe(false);
    expect(privatePayStatus()).toBe("not_configured");
  });

  it("flag on AND UNLINK_API_KEY + ARC_TESTNET_USDC present => on", () => {
    process.env.UNLINK_PRIVATE_PAY = "true";
    process.env.UNLINK_API_KEY = "sk_test";
    process.env.ARC_TESTNET_USDC = "0x0000000000000000000000000000000000000abc";
    expect(isPrivatePayConfigured()).toBe(true);
    expect(privatePayStatus()).toBe("on");
  });

  it("missing only ARC_TESTNET_USDC keeps it not_configured", () => {
    process.env.UNLINK_PRIVATE_PAY = "true";
    process.env.UNLINK_API_KEY = "sk_test";
    expect(privatePayStatus()).toBe("not_configured");
  });
});
