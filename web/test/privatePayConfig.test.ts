import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  isPrivatePayFlagOn,
  isEarningsPrivacyFlagOn,
  isPrivacyFlagOn,
  isPrivatePayConfigured,
  privatePayStatus,
  unlinkChainId,
  unlinkUsdcToken,
} from "../lib/unlink/privatePayConfig.js";
import { ARC_TESTNET_ID } from "../lib/chains.js";

const SAMPLE_USDC = "0x0000000000000000000000000000000000000abc";
const OTHER_CHAIN = 84532; // Base Sepolia — proves the rail is not Arc-locked.

function clear(): void {
  delete process.env.UNLINK_PRIVATE_PAY;
  delete process.env.NEXT_PUBLIC_EARNINGS_PRIVACY;
  delete process.env.UNLINK_API_KEY;
  delete process.env.ARC_TESTNET_USDC;
  delete process.env.NEXT_PUBLIC_UNLINK_CHAIN_ID;
  delete process.env[`NEXT_PUBLIC_UNLINK_USDC_${ARC_TESTNET_ID}`];
  delete process.env[`NEXT_PUBLIC_UNLINK_USDC_${OTHER_CHAIN}`];
}

describe("privatePayConfig", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("flags OFF by default (unset) — status flag_off, not configured", () => {
    expect(isPrivatePayFlagOn()).toBe(false);
    expect(isEarningsPrivacyFlagOn()).toBe(false);
    expect(isPrivacyFlagOn()).toBe(false);
    expect(isPrivatePayConfigured()).toBe(false);
    expect(privatePayStatus()).toBe("flag_off");
  });

  it('only the literal "true" turns the agent flag on (case-insensitive, trimmed)', () => {
    process.env.UNLINK_PRIVATE_PAY = "1";
    expect(isPrivatePayFlagOn()).toBe(false);
    process.env.UNLINK_PRIVATE_PAY = "yes";
    expect(isPrivatePayFlagOn()).toBe(false);
    process.env.UNLINK_PRIVATE_PAY = "  TRUE  ";
    expect(isPrivatePayFlagOn()).toBe(true);
  });

  it('only the literal "true" turns the merchant earnings-privacy knob on', () => {
    process.env.NEXT_PUBLIC_EARNINGS_PRIVACY = "1";
    expect(isEarningsPrivacyFlagOn()).toBe(false);
    process.env.NEXT_PUBLIC_EARNINGS_PRIVACY = "  TRUE  ";
    expect(isEarningsPrivacyFlagOn()).toBe(true);
    expect(isPrivacyFlagOn()).toBe(true);
  });

  it("the merchant earnings-privacy knob alone routes through the same private path", () => {
    process.env.NEXT_PUBLIC_EARNINGS_PRIVACY = "true";
    process.env.UNLINK_API_KEY = "sk_test";
    process.env.ARC_TESTNET_USDC = SAMPLE_USDC;
    expect(isPrivatePayFlagOn()).toBe(false); // agent flag stays off…
    expect(isPrivacyFlagOn()).toBe(true); // …but the privacy gate is on
    expect(isPrivatePayConfigured()).toBe(true);
    expect(privatePayStatus()).toBe("on");
  });

  it("flag on but Unlink env missing => not_configured", () => {
    process.env.UNLINK_PRIVATE_PAY = "true";
    expect(isPrivacyFlagOn()).toBe(true);
    expect(isPrivatePayConfigured()).toBe(false);
    expect(privatePayStatus()).toBe("not_configured");
  });

  it("Arc default: flag on AND UNLINK_API_KEY + ARC_TESTNET_USDC present => on", () => {
    process.env.UNLINK_PRIVATE_PAY = "true";
    process.env.UNLINK_API_KEY = "sk_test";
    process.env.ARC_TESTNET_USDC = SAMPLE_USDC;
    expect(unlinkChainId()).toBe(ARC_TESTNET_ID);
    expect(unlinkUsdcToken()).toBe(SAMPLE_USDC);
    expect(isPrivatePayConfigured()).toBe(true);
    expect(privatePayStatus()).toBe("on");
  });

  it("missing only the shielded USDC token keeps it not_configured", () => {
    process.env.UNLINK_PRIVATE_PAY = "true";
    process.env.UNLINK_API_KEY = "sk_test";
    expect(privatePayStatus()).toBe("not_configured");
  });

  describe("per-chain (de-Arc-locked) token resolution", () => {
    it("defaults to the Arc chain id when NEXT_PUBLIC_UNLINK_CHAIN_ID is unset", () => {
      expect(unlinkChainId()).toBe(ARC_TESTNET_ID);
    });

    it("honours NEXT_PUBLIC_UNLINK_CHAIN_ID for another chain", () => {
      process.env.NEXT_PUBLIC_UNLINK_CHAIN_ID = String(OTHER_CHAIN);
      expect(unlinkChainId()).toBe(OTHER_CHAIN);
    });

    it("a blank/non-numeric chain id falls back to Arc (never guesses)", () => {
      process.env.NEXT_PUBLIC_UNLINK_CHAIN_ID = "not-a-number";
      expect(unlinkChainId()).toBe(ARC_TESTNET_ID);
    });

    it("resolves the USDC token PER CHAIN from NEXT_PUBLIC_UNLINK_USDC_<chainId>", () => {
      process.env.NEXT_PUBLIC_UNLINK_CHAIN_ID = String(OTHER_CHAIN);
      process.env[`NEXT_PUBLIC_UNLINK_USDC_${OTHER_CHAIN}`] = SAMPLE_USDC;
      expect(unlinkUsdcToken()).toBe(SAMPLE_USDC);
    });

    it("the per-chain token wins over the Arc ARC_TESTNET_USDC fallback even on Arc", () => {
      process.env[`NEXT_PUBLIC_UNLINK_USDC_${ARC_TESTNET_ID}`] = SAMPLE_USDC;
      process.env.ARC_TESTNET_USDC = "0x000000000000000000000000000000000000dead";
      expect(unlinkUsdcToken()).toBe(SAMPLE_USDC);
    });

    it("a non-Arc chain with no per-chain token does NOT fall back to ARC_TESTNET_USDC", () => {
      process.env.NEXT_PUBLIC_UNLINK_CHAIN_ID = String(OTHER_CHAIN);
      process.env.ARC_TESTNET_USDC = SAMPLE_USDC; // Arc fallback must not leak cross-chain
      expect(unlinkUsdcToken()).toBe("");
    });

    it("end-to-end: flag on + per-chain token on another chain => on", () => {
      process.env.UNLINK_PRIVATE_PAY = "true";
      process.env.UNLINK_API_KEY = "sk_test";
      process.env.NEXT_PUBLIC_UNLINK_CHAIN_ID = String(OTHER_CHAIN);
      process.env[`NEXT_PUBLIC_UNLINK_USDC_${OTHER_CHAIN}`] = SAMPLE_USDC;
      expect(isPrivatePayConfigured()).toBe(true);
      expect(privatePayStatus()).toBe("on");
    });
  });
});
