import { describe, it, expect, afterEach } from 'vitest'
import {
  ARC_TESTNET_ID,
  ARC_TESTNET_USDC_ADDRESS,
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
