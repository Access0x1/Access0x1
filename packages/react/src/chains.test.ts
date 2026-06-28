/**
 * @file Tests for the settlement-chain registry.
 *
 * These lock down the two things the registry is responsible for: a correct `getChainConfig` lookup
 * by EVM chain id, and the integrity invariants the doctrine relies on — unique chain ids, the
 * deployed-vs-pending USDC split (deployed chains carry a Circle USDC address; pending chains keep
 * `usdc` undefined, never an invented address — law #4), and Arc as the sole gasless-USDC chain. The
 * native-token sentinels (`NATIVE_TOKEN`, `ZERO_BYTES32`) are pinned to their canonical zero values.
 */

import { describe, it, expect } from 'vitest';
import { CHAINS, getChainConfig } from './chains.js';
import { NATIVE_TOKEN, ZERO_BYTES32 } from './types.js';

describe('getChainConfig', () => {
  it('returns the Arc Testnet config for 5042002', () => {
    expect(getChainConfig(5042002)).toBe(CHAINS.arcTestnet);
  });

  it('returns the Base Sepolia config for 84532', () => {
    expect(getChainConfig(84532)).toBe(CHAINS.baseSepolia);
  });

  it('returns the zkSync Sepolia config for 300', () => {
    expect(getChainConfig(300)).toBe(CHAINS.zksyncSepolia);
  });

  it('returns undefined for an unknown chain id', () => {
    expect(getChainConfig(9999)).toBeUndefined();
  });

  it('returns undefined for chain id 0', () => {
    expect(getChainConfig(0)).toBeUndefined();
  });
});

describe('CHAINS registry integrity', () => {
  const entries = Object.values(CHAINS);

  it('every entry has a unique chainId', () => {
    const ids = entries.map((c) => c.chainId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has name, chainId, and usdcIsNativeGas set', () => {
    for (const c of entries) {
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.chainId).toBe('number');
      expect(typeof c.usdcIsNativeGas).toBe('boolean');
    }
  });

  it('deployed chains (Arc, Base) carry a USDC address', () => {
    expect(CHAINS.arcTestnet.usdc).toBeDefined();
    expect(CHAINS.baseSepolia.usdc).toBeDefined();
  });

  it('pending chains keep usdc undefined (never an invented address)', () => {
    // zkSync is config-confirmed but its USDC is host-supplied; the rest are deploy-pending.
    expect(CHAINS.zksyncSepolia.usdc).toBeUndefined();
    expect(CHAINS.zeroGGalileo.usdc).toBeUndefined();
    expect(CHAINS.monadTestnet.usdc).toBeUndefined();
    expect(CHAINS.berachainBepolia.usdc).toBeUndefined();
    expect(CHAINS.seiTestnet.usdc).toBeUndefined();
    expect(CHAINS.megaethTestnet.usdc).toBeUndefined();
  });

  it('Arc is the only chain where USDC is the native gas token', () => {
    const gaslessUsdc = entries.filter((c) => c.usdcIsNativeGas);
    expect(gaslessUsdc).toEqual([CHAINS.arcTestnet]);
  });

  it('every chain other than Arc has usdcIsNativeGas === false', () => {
    for (const c of entries) {
      if (c === CHAINS.arcTestnet) continue;
      expect(c.usdcIsNativeGas).toBe(false);
    }
  });
});

describe('native-token sentinels', () => {
  it('NATIVE_TOKEN is address(0)', () => {
    expect(NATIVE_TOKEN).toBe('0x0000000000000000000000000000000000000000');
  });

  it('ZERO_BYTES32 is 32 zero bytes (66-char 0x-prefixed hex)', () => {
    expect(ZERO_BYTES32).toBe(`0x${'0'.repeat(64)}`);
    expect(ZERO_BYTES32).toHaveLength(66);
  });
});
