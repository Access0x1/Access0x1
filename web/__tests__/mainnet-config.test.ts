/**
 * @file mainnet-config.test.ts — MAINNET config profiles in lib/chains.ts.
 *
 * AUDIT-GATED, NOT DEPLOYED. Every chain has a testnet AND a mainnet profile;
 * these tests pin the TRUTH properties of the mainnet twin (law #4 + the repo is
 * testnet-only today):
 *   - the 13 mainnets are present and distinct from the testnet set;
 *   - Arc mainnet is ABSENT (not launched, id unknown — never invented);
 *   - NO mainnet is gas-free (gas-free is Arc-only, and Arc mainnet isn't live);
 *   - mainnet USDC display decimals are the canonical 6;
 *   - addresses are env-driven (undefined-until-set), never hardcoded — so a
 *     missing config THROWS rather than resolving to a guessed address.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  bsc,
  scroll,
  linea,
  mantle,
  blast,
  unichain,
  zksync,
} from 'viem/chains'
import {
  ARC_TESTNET_ID,
  MAINNET_CHAINS,
  SUPPORTED_CHAINS,
  getRouterAddress,
  getUsdcAddress,
  isGasFree,
  tokenDecimalsFor,
} from '../lib/chains.js'

const EXPECTED_MAINNET_IDS = [
  mainnet.id, // 1
  base.id, // 8453
  arbitrum.id, // 42161
  optimism.id, // 10
  polygon.id, // 137
  avalanche.id, // 43114
  bsc.id, // 56
  scroll.id, // 534352
  linea.id, // 59144
  mantle.id, // 5000
  blast.id, // 81457
  unichain.id, // 130
  zksync.id, // 324
]

describe('MAINNET_CHAINS — config/readiness only, no claim of being live', () => {
  it('lists exactly the 13 mainnets the spec stages (by canonical viem id)', () => {
    expect(MAINNET_CHAINS.map((c) => c.id)).toEqual(EXPECTED_MAINNET_IDS)
  })

  it('every mainnet id is distinct from the testnet set (no overlap with SUPPORTED_CHAINS)', () => {
    const testnetIds = new Set(SUPPORTED_CHAINS.map((c) => c.id))
    for (const id of MAINNET_CHAINS.map((c) => c.id)) {
      expect(testnetIds.has(id)).toBe(false)
    }
  })

  it('Arc MAINNET is absent — not launched, id unknown, never invented (law #4)', () => {
    // The only Arc entry anywhere is the TESTNET; no mainnet carries the Arc id.
    expect(MAINNET_CHAINS.some((c) => c.id === ARC_TESTNET_ID)).toBe(false)
  })
})

describe('MAINNET gas-free policy — gas-free is Arc-only, Arc mainnet is not live', () => {
  it('no staged mainnet is gas-free', () => {
    for (const id of EXPECTED_MAINNET_IDS) {
      expect(isGasFree(id)).toBe(false)
    }
  })
})

describe('MAINNET USDC display decimals — canonical 6-dec ERC-20', () => {
  it('every staged mainnet renders USDC at 6 decimals', () => {
    for (const id of EXPECTED_MAINNET_IDS) {
      expect(tokenDecimalsFor(id)).toBe(6)
    }
  })
})

describe('MAINNET addresses are env-driven — undefined until set, never hardcoded', () => {
  const ROUTER_KEYS = EXPECTED_MAINNET_IDS.map((id) => `NEXT_PUBLIC_ROUTER_ADDRESS_${id}`)
  const USDC_KEYS = EXPECTED_MAINNET_IDS.map((id) => `NEXT_PUBLIC_USDC_ADDRESS_${id}`)

  afterEach(() => {
    for (const k of [...ROUTER_KEYS, ...USDC_KEYS]) delete process.env[k]
  })

  it('getRouterAddress throws for a mainnet with no env set (no guessed address)', () => {
    for (const id of EXPECTED_MAINNET_IDS) {
      delete process.env[`NEXT_PUBLIC_ROUTER_ADDRESS_${id}`]
      expect(() => getRouterAddress(id)).toThrow()
    }
  })

  it('getUsdcAddress throws for a mainnet with no env set (no guessed address)', () => {
    for (const id of EXPECTED_MAINNET_IDS) {
      delete process.env[`NEXT_PUBLIC_USDC_ADDRESS_${id}`]
      expect(() => getUsdcAddress(id)).toThrow()
    }
  })

  it('once env is set, the resolver returns exactly that address (no override, no guess)', () => {
    const id = base.id
    const addr = '0x00000000000000000000000000000000000000aa'
    process.env[`NEXT_PUBLIC_ROUTER_ADDRESS_${id}`] = addr
    expect(getRouterAddress(id)).toBe(addr)
  })
})
