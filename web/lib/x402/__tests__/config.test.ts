/**
 * @file config.test.ts — the PER-CHAIN x402 config seam (lib/x402/config.ts).
 *
 * Coverage pins:
 *   - Arc (5042002) with NO env ⇒ resolves to the booth-confirmed defaults
 *     (lib/arc-constants.ts) — existing behavior is UNCHANGED.
 *   - Per-chain env overrides each value for any chain.
 *   - A non-Arc chain with no env is UNCONFIGURED — resolveX402Config THROWS a
 *     clear error naming the missing var, and never invents an address (law #4).
 *   - network falls back to eip155:<chainId> (a pure derivation, not an address).
 *   - isX402Configured reflects whether USDC + Gateway + facilitator all resolve.
 *   - X402_CONFIGURE_NOTE names the four per-chain env knobs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ARC_TESTNET_FACILITATOR_URL,
  ARC_TESTNET_GATEWAY_WALLET,
  ARC_TESTNET_NETWORK,
  ARC_TESTNET_USDC,
} from '../../arc-constants'
import { ARC_TESTNET_ID } from '../../chains'
import {
  isX402Configured,
  resolveX402Config,
  x402FacilitatorUrl,
  x402GatewayWallet,
  x402Network,
  x402Usdc,
  X402_CONFIGURE_NOTE,
} from '../config'

const OTHER_CHAIN_ID = 84532 // Base Sepolia — no baked-in x402 default

function clearChainEnv(chainId: number): void {
  for (const suffix of ['NETWORK', 'USDC', 'GATEWAY', 'FACILITATOR_URL']) {
    delete process.env[`NEXT_PUBLIC_X402_${suffix}_${chainId}`]
  }
}

function clearAllEnv(): void {
  clearChainEnv(ARC_TESTNET_ID)
  clearChainEnv(OTHER_CHAIN_ID)
}

beforeEach(clearAllEnv)
afterEach(clearAllEnv)

// ---------------------------------------------------------------------------
// 1. Arc default — UNCHANGED behavior
// ---------------------------------------------------------------------------

describe('Arc (5042002) defaults — unchanged when no env is set', () => {
  it('resolveX402Config() returns the booth-confirmed Arc values', () => {
    const cfg = resolveX402Config(ARC_TESTNET_ID)
    expect(cfg).toEqual({
      chainId: ARC_TESTNET_ID,
      network: ARC_TESTNET_NETWORK,
      asset: ARC_TESTNET_USDC,
      gatewayWallet: ARC_TESTNET_GATEWAY_WALLET,
      facilitatorUrl: ARC_TESTNET_FACILITATOR_URL,
    })
  })

  it('default chainId IS Arc — resolveX402Config() with no arg == Arc config', () => {
    expect(resolveX402Config()).toEqual(resolveX402Config(ARC_TESTNET_ID))
  })

  it('per-value getters return the Arc defaults', () => {
    expect(x402Network(ARC_TESTNET_ID)).toBe(ARC_TESTNET_NETWORK)
    expect(x402Usdc(ARC_TESTNET_ID)).toBe(ARC_TESTNET_USDC)
    expect(x402GatewayWallet(ARC_TESTNET_ID)).toBe(ARC_TESTNET_GATEWAY_WALLET)
    expect(x402FacilitatorUrl(ARC_TESTNET_ID)).toBe(ARC_TESTNET_FACILITATOR_URL)
  })

  it('isX402Configured(Arc) is true with no env', () => {
    expect(isX402Configured(ARC_TESTNET_ID)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Per-chain env overrides
// ---------------------------------------------------------------------------

describe('per-chain env overrides', () => {
  it('env overrides each Arc value', () => {
    process.env.NEXT_PUBLIC_X402_NETWORK_5042002 = 'eip155:99999'
    process.env.NEXT_PUBLIC_X402_USDC_5042002 =
      '0x1111111111111111111111111111111111111111'
    process.env.NEXT_PUBLIC_X402_GATEWAY_5042002 =
      '0x2222222222222222222222222222222222222222'
    process.env.NEXT_PUBLIC_X402_FACILITATOR_URL_5042002 =
      'https://facilitator.example.test'

    expect(resolveX402Config(ARC_TESTNET_ID)).toEqual({
      chainId: ARC_TESTNET_ID,
      network: 'eip155:99999',
      asset: '0x1111111111111111111111111111111111111111',
      gatewayWallet: '0x2222222222222222222222222222222222222222',
      facilitatorUrl: 'https://facilitator.example.test',
    })
  })

  it('a fully-configured non-Arc chain resolves from env', () => {
    process.env.NEXT_PUBLIC_X402_USDC_84532 =
      '0x3333333333333333333333333333333333333333'
    process.env.NEXT_PUBLIC_X402_GATEWAY_84532 =
      '0x4444444444444444444444444444444444444444'
    process.env.NEXT_PUBLIC_X402_FACILITATOR_URL_84532 =
      'https://base-facilitator.example.test'

    const cfg = resolveX402Config(OTHER_CHAIN_ID)
    expect(cfg.asset).toBe('0x3333333333333333333333333333333333333333')
    expect(cfg.gatewayWallet).toBe('0x4444444444444444444444444444444444444444')
    expect(cfg.facilitatorUrl).toBe('https://base-facilitator.example.test')
    // network defaults to the eip155 derivation when not overridden.
    expect(cfg.network).toBe(`eip155:${OTHER_CHAIN_ID}`)
  })
})

// ---------------------------------------------------------------------------
// 3. Unconfigured non-Arc chain — hard stop, never invents an address
// ---------------------------------------------------------------------------

describe('unconfigured non-Arc chain — law #4 (never guess an address)', () => {
  it('x402Usdc / gateway / facilitator return empty for an unconfigured chain', () => {
    expect(x402Usdc(OTHER_CHAIN_ID)).toBe('')
    expect(x402GatewayWallet(OTHER_CHAIN_ID)).toBe('')
    expect(x402FacilitatorUrl(OTHER_CHAIN_ID)).toBe('')
  })

  it('network still derives to eip155:<chainId> (a derivation, not an address)', () => {
    expect(x402Network(OTHER_CHAIN_ID)).toBe(`eip155:${OTHER_CHAIN_ID}`)
  })

  it('isX402Configured is false for an unconfigured chain', () => {
    expect(isX402Configured(OTHER_CHAIN_ID)).toBe(false)
  })

  it('resolveX402Config throws naming the missing USDC var', () => {
    expect(() => resolveX402Config(OTHER_CHAIN_ID)).toThrow(
      /NEXT_PUBLIC_X402_USDC_84532/,
    )
  })

  it('resolveX402Config throws naming the missing Gateway var (USDC set)', () => {
    process.env.NEXT_PUBLIC_X402_USDC_84532 =
      '0x3333333333333333333333333333333333333333'
    expect(() => resolveX402Config(OTHER_CHAIN_ID)).toThrow(
      /NEXT_PUBLIC_X402_GATEWAY_84532/,
    )
  })

  it('resolveX402Config throws naming the missing facilitator var (USDC + Gateway set)', () => {
    process.env.NEXT_PUBLIC_X402_USDC_84532 =
      '0x3333333333333333333333333333333333333333'
    process.env.NEXT_PUBLIC_X402_GATEWAY_84532 =
      '0x4444444444444444444444444444444444444444'
    expect(() => resolveX402Config(OTHER_CHAIN_ID)).toThrow(
      /NEXT_PUBLIC_X402_FACILITATOR_URL_84532/,
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Configure note
// ---------------------------------------------------------------------------

describe('X402_CONFIGURE_NOTE', () => {
  it('names all four per-chain env knobs', () => {
    expect(X402_CONFIGURE_NOTE).toContain('NEXT_PUBLIC_X402_NETWORK_')
    expect(X402_CONFIGURE_NOTE).toContain('NEXT_PUBLIC_X402_USDC_')
    expect(X402_CONFIGURE_NOTE).toContain('NEXT_PUBLIC_X402_GATEWAY_')
    expect(X402_CONFIGURE_NOTE).toContain('NEXT_PUBLIC_X402_FACILITATOR_URL_')
  })
})
