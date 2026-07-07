/**
 * @file embedConfig.test.ts — the One-Tag Checkout chain registry (lib/embedConfig.ts).
 *
 * embedConfig is the build-side source of truth that mirrors the CHAIN_DEFAULTS
 * baked into public/embed.js. Because the embed is a zero-dependency IIFE that
 * cannot import this module, the two are kept in sync by convention — so the
 * invariants worth pinning are exactly the ones a silent drift would break:
 *   - DOCTRINE: no router/USDC address is ever hardcoded — every one is read from
 *     a NEXT_PUBLIC_* env var and is `undefined` until that var is set,
 *   - the env address flows onto the correct chain,
 *   - known USDC decimals are fixed (Arc native = 18, ERC-20 chains = 6),
 *   - the registry is frozen (a shared config callers must not mutate),
 *   - EMBED_ADDRESS_PLACEHOLDERS and buildEmbedConfig never drift apart — every
 *     declared placeholder env-var is actually consumed, and the counts match.
 *
 * All assertions are pure (buildEmbedConfig takes an explicit env map); no source
 * behavior is changed by this file.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEmbedConfig,
  EMBED_ADDRESS_PLACEHOLDERS,
  DEFAULT_CHAIN_ID,
} from '../lib/embedConfig';
import { ARC_TESTNET_ID } from '../lib/chains';

const EMPTY: Record<string, string | undefined> = {};

describe('embedConfig — One-Tag Checkout chain registry', () => {
  it('DEFAULT_CHAIN_ID is Arc testnet and is a key in the registry', () => {
    expect(DEFAULT_CHAIN_ID).toBe(ARC_TESTNET_ID);
    const cfg = buildEmbedConfig(EMPTY);
    expect(cfg[DEFAULT_CHAIN_ID]).toBeDefined();
    expect(cfg[DEFAULT_CHAIN_ID].chainId).toBe(ARC_TESTNET_ID);
  });

  it('DOCTRINE: with an EMPTY env every router/USDC address is undefined (never hardcoded)', () => {
    const cfg = buildEmbedConfig(EMPTY);
    const chains = Object.values(cfg);
    expect(chains.length).toBeGreaterThan(0);
    for (const c of chains) {
      expect(c.router, `${c.name} router must be undefined with empty env`).toBeUndefined();
      expect(c.usdc, `${c.name} usdc must be undefined with empty env`).toBeUndefined();
      // non-address fields ARE safe to bake and must be populated
      expect(c.name).toBeTruthy();
      expect(c.rpc).toMatch(/^https:\/\//);
      expect(c.usdcDecimals).toBeGreaterThan(0);
      expect(Number.isInteger(c.chainId)).toBe(true);
    }
  });

  it('reads addresses straight from NEXT_PUBLIC_* env vars onto the right chains', () => {
    const cfg = buildEmbedConfig({
      NEXT_PUBLIC_ROUTER_ARC: '0xArcRouter',
      NEXT_PUBLIC_USDC_ARC: '0xArcUsdc',
      NEXT_PUBLIC_ROUTER_BASE_SEPOLIA: '0xBaseRouter',
      NEXT_PUBLIC_USDC_BASE_SEPOLIA: '0xBaseUsdc',
      NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA: '0xZkRouter',
      NEXT_PUBLIC_USDC_ZKSYNC_SEPOLIA: '0xZkUsdc',
    });
    expect(cfg[ARC_TESTNET_ID].router).toBe('0xArcRouter');
    expect(cfg[ARC_TESTNET_ID].usdc).toBe('0xArcUsdc');
    expect(cfg[84532].router).toBe('0xBaseRouter');
    expect(cfg[84532].usdc).toBe('0xBaseUsdc');
    expect(cfg[300].router).toBe('0xZkRouter');
    expect(cfg[300].usdc).toBe('0xZkUsdc');
  });

  it('pins known USDC decimals — Arc native = 18, ERC-20 chains = 6', () => {
    const cfg = buildEmbedConfig(EMPTY);
    expect(cfg[ARC_TESTNET_ID].usdcDecimals).toBe(18);
    expect(cfg[84532].usdcDecimals).toBe(6);
    expect(cfg[300].usdcDecimals).toBe(6);
  });

  it('returns a frozen registry — callers cannot mutate the shared config', () => {
    const cfg = buildEmbedConfig(EMPTY);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('PARITY: every EMBED_ADDRESS_PLACEHOLDERS env-var is actually consumed by buildEmbedConfig', () => {
    const envVarNames = Object.values(EMBED_ADDRESS_PLACEHOLDERS);
    // each placeholder maps to a distinct NEXT_PUBLIC_* name
    expect(new Set(envVarNames).size).toBe(envVarNames.length);
    for (const name of envVarNames) {
      expect(name.startsWith('NEXT_PUBLIC_'), `${name} should be a NEXT_PUBLIC_* var`).toBe(true);
      // set ONLY this var to a sentinel; it must surface as some chain's router or usdc,
      // proving the placeholder is not orphaned relative to the config it mirrors.
      const sentinel = `SENTINEL::${name}`;
      const cfg = buildEmbedConfig({ [name]: sentinel });
      const surfaced = Object.values(cfg).some((c) => c.router === sentinel || c.usdc === sentinel);
      expect(surfaced, `${name} is declared as a placeholder but never read by buildEmbedConfig`).toBe(true);
    }
  });

  it('PARITY (count): placeholder count equals the address slots the registry exposes (2 per chain)', () => {
    const cfg = buildEmbedConfig(EMPTY);
    const addressSlots = Object.keys(cfg).length * 2; // router + usdc per chain
    expect(Object.keys(EMBED_ADDRESS_PLACEHOLDERS).length).toBe(addressSlots);
  });
});
