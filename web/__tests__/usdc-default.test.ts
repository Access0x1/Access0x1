import { describe, it, expect, afterEach } from 'vitest'
import { baseSepolia, sepolia } from 'viem/chains'
import {
  ARC_TESTNET_ID,
  ARC_TESTNET_USDC_ADDRESS,
  BASE_SEPOLIA_USDC_ADDRESS,
  ETH_SEPOLIA_USDC_ADDRESS,
  getRouterAddress,
  getUsdcAddress,
  MIRROR_ROUTER_ADDRESS,
} from '../lib/chains.js'
import { ARC_TESTNET_USDC } from '../lib/arc-constants.js'

/**
 * Zero-config USDC on the LEAD chain: Arc's USDC is the chain-spec native/system
 * token (0x3600…0000 — a public chain fact, like the chain id), so a fresh
 * clone's checkout quote works on the default chain with NO env at all. An env
 * value still overrides; a BLANK env value (a wholesale-copied .env.example)
 * never shadows a working default; and a non-Arc, unconfigured chain still
 * fails loud — never a guessed address (law #4).
 */
describe('Arc USDC zero-config default', () => {
  afterEach(() => {
    delete process.env[`NEXT_PUBLIC_USDC_ADDRESS_${ARC_TESTNET_ID}`]
    delete process.env[`NEXT_PUBLIC_ROUTER_ADDRESS_${ARC_TESTNET_ID}`]
  })

  it('resolves the Arc system USDC with no env at all', () => {
    delete process.env[`NEXT_PUBLIC_USDC_ADDRESS_${ARC_TESTNET_ID}`]
    expect(getUsdcAddress(ARC_TESTNET_ID)).toBe(ARC_TESTNET_USDC_ADDRESS)
  })

  it('pins the default to the verbatim Arc system contract (real, not mock)', () => {
    expect(ARC_TESTNET_USDC_ADDRESS).toBe('0x3600000000000000000000000000000000000000')
  })

  it('arc-constants re-exports the SAME value (single source, no drift)', () => {
    expect(ARC_TESTNET_USDC).toBe(ARC_TESTNET_USDC_ADDRESS)
  })

  it('lets a per-chain env override win over the default', () => {
    const override = '0x00000000000000000000000000000000000000cc'
    process.env[`NEXT_PUBLIC_USDC_ADDRESS_${ARC_TESTNET_ID}`] = override
    expect(getUsdcAddress(ARC_TESTNET_ID)).toBe(override)
  })

  it('a BLANK env value falls back to the default, never an empty address', () => {
    process.env[`NEXT_PUBLIC_USDC_ADDRESS_${ARC_TESTNET_ID}`] = ''
    expect(getUsdcAddress(ARC_TESTNET_ID)).toBe(ARC_TESTNET_USDC_ADDRESS)
  })

  it('a BLANK router env falls back to the mirror, never an empty address', () => {
    process.env[`NEXT_PUBLIC_ROUTER_ADDRESS_${ARC_TESTNET_ID}`] = ''
    expect(getRouterAddress(ARC_TESTNET_ID)).toBe(MIRROR_ROUTER_ADDRESS)
  })

  it('still fails loud for a non-Arc, unconfigured chain (never a guessed USDC)', () => {
    expect(() => getUsdcAddress(9_999_999)).toThrow()
  })
})

/**
 * Zero-config USDC on Base Sepolia — the chain that carries the live, `active`
 * merchant #1 on the mirror router. Circle's canonical testnet USDC is a public,
 * documented chain fact (verified allowlisted + quotable on-chain), so the
 * hosted checkout there settles with NO env — the same carve-out as Arc, and
 * the counterpart to the mirror-router default already resolved for 84532. An
 * env value still overrides; a BLANK env never shadows the default.
 */
describe('Base Sepolia USDC zero-config default', () => {
  afterEach(() => {
    delete process.env[`NEXT_PUBLIC_USDC_ADDRESS_${baseSepolia.id}`]
  })

  it('resolves the canonical Base Sepolia USDC with no env at all', () => {
    delete process.env[`NEXT_PUBLIC_USDC_ADDRESS_${baseSepolia.id}`]
    expect(getUsdcAddress(baseSepolia.id)).toBe(BASE_SEPOLIA_USDC_ADDRESS)
  })

  it('pins the default to Circle’s canonical Base Sepolia USDC (verified on-chain)', () => {
    expect(BASE_SEPOLIA_USDC_ADDRESS).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
  })

  it('pairs with the mirror router default so the whole checkout is zero-config on 84532', () => {
    delete process.env[`NEXT_PUBLIC_USDC_ADDRESS_${baseSepolia.id}`]
    expect(getRouterAddress(baseSepolia.id)).toBe(MIRROR_ROUTER_ADDRESS)
    expect(getUsdcAddress(baseSepolia.id)).toBe(BASE_SEPOLIA_USDC_ADDRESS)
  })

  it('lets a per-chain env override win over the default', () => {
    const override = '0x00000000000000000000000000000000000000dd'
    process.env[`NEXT_PUBLIC_USDC_ADDRESS_${baseSepolia.id}`] = override
    expect(getUsdcAddress(baseSepolia.id)).toBe(override)
  })

  it('a BLANK env value falls back to the default, never an empty address', () => {
    process.env[`NEXT_PUBLIC_USDC_ADDRESS_${baseSepolia.id}`] = ''
    expect(getUsdcAddress(baseSepolia.id)).toBe(BASE_SEPOLIA_USDC_ADDRESS)
  })
})

/**
 * Zero-config USDC on Ethereum Sepolia — the L1 testnet where the CREATE3 mirror
 * is deployed + source-verified. Circle's canonical testnet USDC is a public,
 * documented chain fact (verified allowlisted + quotable on-chain), so the hosted
 * checkout settles there with NO env — the same carve-out as Arc and Base Sepolia,
 * and the counterpart to the mirror-router default already resolved for 11155111.
 */
describe('Ethereum Sepolia USDC zero-config default', () => {
  afterEach(() => {
    delete process.env[`NEXT_PUBLIC_USDC_ADDRESS_${sepolia.id}`]
  })

  it('resolves the canonical Ethereum Sepolia USDC with no env at all', () => {
    delete process.env[`NEXT_PUBLIC_USDC_ADDRESS_${sepolia.id}`]
    expect(getUsdcAddress(sepolia.id)).toBe(ETH_SEPOLIA_USDC_ADDRESS)
  })

  it('pins the default to Circle’s canonical Ethereum Sepolia USDC (verified on-chain)', () => {
    expect(ETH_SEPOLIA_USDC_ADDRESS).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')
  })

  it('pairs with the mirror router default so the whole checkout is zero-config on 11155111', () => {
    delete process.env[`NEXT_PUBLIC_USDC_ADDRESS_${sepolia.id}`]
    expect(getRouterAddress(sepolia.id)).toBe(MIRROR_ROUTER_ADDRESS)
    expect(getUsdcAddress(sepolia.id)).toBe(ETH_SEPOLIA_USDC_ADDRESS)
  })

  it('lets a per-chain env override win over the default', () => {
    const override = '0x00000000000000000000000000000000000000ee'
    process.env[`NEXT_PUBLIC_USDC_ADDRESS_${sepolia.id}`] = override
    expect(getUsdcAddress(sepolia.id)).toBe(override)
  })

  it('a BLANK env value falls back to the default, never an empty address', () => {
    process.env[`NEXT_PUBLIC_USDC_ADDRESS_${sepolia.id}`] = ''
    expect(getUsdcAddress(sepolia.id)).toBe(ETH_SEPOLIA_USDC_ADDRESS)
  })
})
