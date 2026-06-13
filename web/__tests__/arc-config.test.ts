/**
 * @file arc-config.test.ts — the deterministic Arc lead-chain config lock.
 *
 * Arc is the LEAD settlement chain: native USDC IS the gas token, so checkout is
 * gas-free, and that native USDC is 18-decimal (the "Arc trap"). This file pins
 * the Arc-specific constants that the demo and the money/display paths depend on
 * — in ONE place, with NO env reads and NO `vm.setEnv` race — so a wrong nibble
 * or a regressed decimal/gas-free policy fails CI loudly before the booth demo.
 *
 * Scope (intentionally narrow, distinct from token-decimals.test.ts):
 *   - the canonical Arc chain id (5042002) — one source, no re-literal drift
 *   - the Arc USDC system contract address (0x3600…0000) — VERBATIM, the value
 *     `token-decimals.test.ts` does not assert
 *   - the Arc network CAIP-2 id derives from that same chain id
 *   - native decimals 18 on the viem chain object
 *   - the isGasFree truth-table: true ONLY on Arc, false on Base / ZKsync
 *     (truth-in-copy law #4 — the "no separate gas" copy gates on this)
 *   - tokenDecimalsFor(arc) === 18 tracks the chain config (not a magic number)
 */
import { describe, expect, it } from 'vitest'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'
import { ARC_TESTNET_ID, arcTestnet, isGasFree, tokenDecimalsFor } from '../lib/chains.js'
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC } from '../lib/arc-constants.js'

describe('Arc lead-chain identity', () => {
  it('chain id is the canonical 5042002', () => {
    expect(ARC_TESTNET_ID).toBe(5042002)
    expect(arcTestnet.id).toBe(ARC_TESTNET_ID)
  })

  it('USDC is the Arc system contract 0x3600…0000 (verbatim, real not mock)', () => {
    expect(ARC_TESTNET_USDC).toBe('0x3600000000000000000000000000000000000000')
  })

  it('the CAIP-2 network id derives from the canonical chain id (no drift)', () => {
    expect(ARC_TESTNET_NETWORK).toBe(`eip155:${ARC_TESTNET_ID}`)
    expect(ARC_TESTNET_NETWORK).toBe('eip155:5042002')
  })
})

describe('Arc native USDC is 18-decimal (the "Arc trap")', () => {
  it('the viem chain object carries 18 native decimals', () => {
    expect(arcTestnet.nativeCurrency.decimals).toBe(18)
    expect(arcTestnet.nativeCurrency.symbol).toBe('USDC')
  })

  it('tokenDecimalsFor(arc) === 18 and tracks the chain config', () => {
    expect(tokenDecimalsFor(ARC_TESTNET_ID)).toBe(18)
    expect(tokenDecimalsFor(ARC_TESTNET_ID)).toBe(arcTestnet.nativeCurrency.decimals)
  })
})

describe('Arc is gas-free; the bridged-USDC L2s are not (law #4)', () => {
  it('isGasFree(arc) === true — native USDC pays gas', () => {
    expect(isGasFree(ARC_TESTNET_ID)).toBe(true)
  })

  it('isGasFree(baseSepolia) === false — gas is ETH there', () => {
    expect(isGasFree(baseSepolia.id)).toBe(false)
  })

  it('isGasFree(zksyncSepolia) === false — gas is ETH there', () => {
    expect(isGasFree(zksyncSepoliaTestnet.id)).toBe(false)
  })
})
