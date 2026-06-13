/**
 * @file token-decimals.test.ts — per-chain USDC decimals + gas-free policy.
 *
 * The "Arc trap": Arc's native USDC is 18-dec while bridged USDC on the L2
 * testnets is 6-dec. A hardcoded `6` mis-renders an Arc amount by 10^12 on the
 * LEAD chain. `tokenDecimalsFor` resolves decimals PER CHAIN; `isGasFree` gates
 * "no separate gas" copy on the one chain where USDC IS the gas token (law #4).
 */
import { describe, expect, it } from 'vitest'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'
import {
  ARC_TESTNET_ID,
  DEFAULT_TOKEN_DECIMALS,
  arcTestnet,
  isGasFree,
  tokenDecimalsFor,
} from '../lib/chains.js'

describe('tokenDecimalsFor — per-chain USDC display decimals', () => {
  it('Arc Testnet -> 18 (native USDC is the 18-dec gas token, the "Arc trap")', () => {
    expect(tokenDecimalsFor(ARC_TESTNET_ID)).toBe(18)
  })

  it('Arc decimals track the chain config (not a magic number)', () => {
    expect(tokenDecimalsFor(ARC_TESTNET_ID)).toBe(arcTestnet.nativeCurrency.decimals)
  })

  it('Base Sepolia -> 6 (canonical bridged-USDC ERC-20)', () => {
    expect(tokenDecimalsFor(baseSepolia.id)).toBe(6)
  })

  it('ZKsync Sepolia -> 6 (canonical bridged-USDC ERC-20)', () => {
    expect(tokenDecimalsFor(zksyncSepoliaTestnet.id)).toBe(6)
  })

  it('unknown chain -> the ERC-20 default (6), never a throw', () => {
    expect(tokenDecimalsFor(999999)).toBe(DEFAULT_TOKEN_DECIMALS)
    expect(DEFAULT_TOKEN_DECIMALS).toBe(6)
  })

  it('a 1.00 USDC amount renders correctly per chain (regression for the 10^12 bug)', () => {
    // 1 USDC in Arc base units (18-dec) vs L2 base units (6-dec).
    const oneOnArc = 10n ** BigInt(tokenDecimalsFor(ARC_TESTNET_ID))
    const oneOnL2 = 10n ** BigInt(tokenDecimalsFor(baseSepolia.id))
    // Formatting each with ITS chain's decimals yields 1; cross-applying the
    // wrong (6) decimals to the Arc amount would show 1,000,000,000,000.
    expect(Number(oneOnArc) / 10 ** tokenDecimalsFor(ARC_TESTNET_ID)).toBe(1)
    expect(Number(oneOnL2) / 10 ** tokenDecimalsFor(baseSepolia.id)).toBe(1)
    expect(Number(oneOnArc) / 10 ** 6).toBe(1e12) // the bug, made explicit
  })
})

describe('isGasFree — only true where USDC is the native gas token (law #4)', () => {
  it('Arc Testnet is gas-free (native USDC pays gas)', () => {
    expect(isGasFree(ARC_TESTNET_ID)).toBe(true)
  })

  it('Base Sepolia is NOT gas-free (gas is ETH, not USDC)', () => {
    expect(isGasFree(baseSepolia.id)).toBe(false)
  })

  it('ZKsync Sepolia is NOT gas-free (gas is ETH, not USDC)', () => {
    expect(isGasFree(zksyncSepoliaTestnet.id)).toBe(false)
  })

  it('unknown chain is NOT gas-free', () => {
    expect(isGasFree(999999)).toBe(false)
  })
})
