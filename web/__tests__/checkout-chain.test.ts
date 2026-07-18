import { describe, it, expect, afterEach } from 'vitest'
import { baseSepolia, sepolia, zksyncSepoliaTestnet } from 'viem/chains'
import { ARC_TESTNET_ID, resolveCheckoutChainId } from '../lib/chains.js'

/**
 * The hosted checkout reads its settlement chain from an optional, UNTRUSTED
 * `?chainId=` link param so a link can reach a merchant on a non-default mirror
 * chain (e.g. the live `active` merchant #1 on Base Sepolia while the default is
 * Arc). The param is validated, never trusted: honored only for a SUPPORTED chain
 * that resolves a router; anything else falls back to the default — never a wrong
 * or unconfigured chain, and never a throw (law #4).
 */
describe('resolveCheckoutChainId', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID
  })

  it('falls back to the default (Arc) when the param is absent/blank', () => {
    expect(resolveCheckoutChainId(null)).toBe(ARC_TESTNET_ID)
    expect(resolveCheckoutChainId(undefined)).toBe(ARC_TESTNET_ID)
    expect(resolveCheckoutChainId('')).toBe(ARC_TESTNET_ID)
    expect(resolveCheckoutChainId('   ')).toBe(ARC_TESTNET_ID)
  })

  it('honors a supported, mirror-routed chain (Base Sepolia 84532 — the live merchant chain)', () => {
    expect(resolveCheckoutChainId(String(baseSepolia.id))).toBe(baseSepolia.id)
    expect(resolveCheckoutChainId(' 84532 ')).toBe(baseSepolia.id) // trimmed
  })

  it('honors Ethereum Sepolia (11155111 — mirror deployed + now a supported chain)', () => {
    expect(resolveCheckoutChainId(String(sepolia.id))).toBe(sepolia.id)
  })

  it('rejects a non-numeric / non-integer / non-positive param → default', () => {
    expect(resolveCheckoutChainId('abc')).toBe(ARC_TESTNET_ID)
    expect(resolveCheckoutChainId('84532abc')).toBe(ARC_TESTNET_ID)
    expect(resolveCheckoutChainId('84532.5')).toBe(ARC_TESTNET_ID)
    expect(resolveCheckoutChainId('0')).toBe(ARC_TESTNET_ID)
    expect(resolveCheckoutChainId('-1')).toBe(ARC_TESTNET_ID)
  })

  it('rejects an unsupported chain id → default (never a chain the app cannot handle)', () => {
    expect(resolveCheckoutChainId('999999')).toBe(ARC_TESTNET_ID)
  })

  it('rejects a supported-but-router-less chain (zkSync Sepolia, no mirror + no env) → default', () => {
    // 300 is in SUPPORTED_CHAINS but NOT mirror-deployed and has no env router,
    // so getRouterAddress throws — there is nothing to pay against.
    expect(resolveCheckoutChainId(String(zksyncSepoliaTestnet.id))).toBe(ARC_TESTNET_ID)
  })

  it('the fallback tracks NEXT_PUBLIC_DEFAULT_CHAIN_ID when it is set', () => {
    process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID = String(baseSepolia.id)
    expect(resolveCheckoutChainId('abc')).toBe(baseSepolia.id) // invalid param → the (now Base) default
  })
})
