/**
 * @file index.test.ts — ERC-7677 / EIP-5792 sponsored-gas paymaster seam.
 *
 * Coverage pins:
 *   - Unset env ⇒ the seam is completely OFF (badge hidden, no capability).
 *   - Partially configured ⇒ still OFF (all three vars required).
 *   - Fully configured ⇒ ON; badge shows ONLY on the matching chain.
 *   - Chain mismatch ⇒ badge hidden even when the paymaster URL is set.
 *   - `paymasterCapability()` ⇒ undefined when unconfigured; the correct
 *     EIP-5792 capability object when configured.
 *   - `resolvePaymasterForChain()` ⇒ correct discriminated result in every case.
 *   - PAYMASTER_ENABLED server-only flag: false/blank ⇒ the seam is OFF even
 *     when the public vars are set (client visibility and server gate are separate).
 *   - No throw in any branch (fail-soft law).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isPaymasterEnabled,
  isPaymasterConfigured,
  isPaymasterPublicConfigured,
  isPaymasterActiveForChain,
  paymasterUrl,
  paymasterChainId,
  paymasterCapability,
  resolvePaymasterForChain,
  PAYMASTER_CONFIGURE_NOTE,
} from '../index'

// ---------------------------------------------------------------------------
// Env-var helpers
// ---------------------------------------------------------------------------

const PAYMASTER_ENV = [
  'PAYMASTER_ENABLED',
  'NEXT_PUBLIC_PAYMASTER_URL',
  'NEXT_PUBLIC_PAYMASTER_CHAIN_ID',
] as const

function clearPaymasterEnv(): void {
  for (const k of PAYMASTER_ENV) delete process.env[k]
}

function setFullEnv(chainId = 84532): void {
  process.env.PAYMASTER_ENABLED = 'true'
  process.env.NEXT_PUBLIC_PAYMASTER_URL = 'https://paymaster.example.test/rpc'
  process.env.NEXT_PUBLIC_PAYMASTER_CHAIN_ID = String(chainId)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SEPOLIA_CHAIN_ID = 84532
const OTHER_CHAIN_ID = 5042002 // Arc Testnet

beforeEach(clearPaymasterEnv)
afterEach(clearPaymasterEnv)

// ---------------------------------------------------------------------------
// 1. Unconfigured / fail-soft
// ---------------------------------------------------------------------------

describe('unconfigured — fail-soft, seam is OFF with no env set', () => {
  it('isPaymasterEnabled() is false with no env', () => {
    expect(isPaymasterEnabled()).toBe(false)
  })

  it('isPaymasterConfigured() is false with no env', () => {
    expect(isPaymasterConfigured()).toBe(false)
  })

  it('isPaymasterPublicConfigured() is false with no env', () => {
    expect(isPaymasterPublicConfigured()).toBe(false)
  })

  it('isPaymasterActiveForChain() is false with no env', () => {
    expect(isPaymasterActiveForChain(BASE_SEPOLIA_CHAIN_ID)).toBe(false)
  })

  it('paymasterUrl() returns empty string with no env', () => {
    expect(paymasterUrl()).toBe('')
  })

  it('paymasterChainId() returns 0 with no env', () => {
    expect(paymasterChainId()).toBe(0)
  })

  it('paymasterCapability() returns undefined with no env — no invented capability', () => {
    expect(paymasterCapability()).toBeUndefined()
  })

  it('resolvePaymasterForChain() returns not_configured with no env', () => {
    const result = resolvePaymasterForChain(BASE_SEPOLIA_CHAIN_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('not_configured')
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Partially configured — still OFF (all three vars required for full config)
// ---------------------------------------------------------------------------

describe('partially configured — still OFF', () => {
  it('PAYMASTER_ENABLED=true only ⇒ isPaymasterConfigured false (missing URL + chainId)', () => {
    process.env.PAYMASTER_ENABLED = 'true'
    expect(isPaymasterConfigured()).toBe(false)
  })

  it('URL only (no PAYMASTER_ENABLED, no chainId) ⇒ isPaymasterPublicConfigured false', () => {
    process.env.NEXT_PUBLIC_PAYMASTER_URL = 'https://paymaster.example.test/rpc'
    expect(isPaymasterPublicConfigured()).toBe(false)
  })

  it('URL + chainId but PAYMASTER_ENABLED blank ⇒ isPaymasterConfigured false (server flag OFF)', () => {
    process.env.NEXT_PUBLIC_PAYMASTER_URL = 'https://paymaster.example.test/rpc'
    process.env.NEXT_PUBLIC_PAYMASTER_CHAIN_ID = String(BASE_SEPOLIA_CHAIN_ID)
    // isPaymasterConfigured() checks the server flag; still false when it's blank.
    expect(isPaymasterConfigured()).toBe(false)
    // isPaymasterPublicConfigured() is client-safe and does NOT check the server flag.
    expect(isPaymasterPublicConfigured()).toBe(true)
  })

  it('PAYMASTER_ENABLED=true + URL only (no chainId) ⇒ isPaymasterConfigured false', () => {
    process.env.PAYMASTER_ENABLED = 'true'
    process.env.NEXT_PUBLIC_PAYMASTER_URL = 'https://paymaster.example.test/rpc'
    expect(isPaymasterConfigured()).toBe(false)
  })

  it('paymasterCapability() returns undefined when URL is blank', () => {
    process.env.PAYMASTER_ENABLED = 'true'
    process.env.NEXT_PUBLIC_PAYMASTER_CHAIN_ID = String(BASE_SEPOLIA_CHAIN_ID)
    expect(paymasterCapability()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Fully configured — the seam is ON
// ---------------------------------------------------------------------------

describe('fully configured — seam is ON', () => {
  beforeEach(() => setFullEnv(BASE_SEPOLIA_CHAIN_ID))

  it('isPaymasterEnabled() is true', () => {
    expect(isPaymasterEnabled()).toBe(true)
  })

  it('isPaymasterConfigured() is true', () => {
    expect(isPaymasterConfigured()).toBe(true)
  })

  it('isPaymasterPublicConfigured() is true', () => {
    expect(isPaymasterPublicConfigured()).toBe(true)
  })

  it('paymasterUrl() returns the configured URL', () => {
    expect(paymasterUrl()).toBe('https://paymaster.example.test/rpc')
  })

  it('paymasterChainId() returns the configured chain id', () => {
    expect(paymasterChainId()).toBe(BASE_SEPOLIA_CHAIN_ID)
  })

  it('isPaymasterActiveForChain() is true for the matching chain', () => {
    expect(isPaymasterActiveForChain(BASE_SEPOLIA_CHAIN_ID)).toBe(true)
  })

  it('isPaymasterActiveForChain() is false for a DIFFERENT chain (truth-in-copy law)', () => {
    // A paymaster configured for Base Sepolia must NOT claim sponsorship for Arc.
    expect(isPaymasterActiveForChain(OTHER_CHAIN_ID)).toBe(false)
  })

  it('paymasterCapability() returns the EIP-5792 paymasterService capability object', () => {
    const cap = paymasterCapability()
    expect(cap).toBeDefined()
    expect(cap).toEqual({
      paymasterService: { url: 'https://paymaster.example.test/rpc' },
    })
  })

  it('resolvePaymasterForChain() returns ok:true with url + chainId for the matching chain', () => {
    const result = resolvePaymasterForChain(BASE_SEPOLIA_CHAIN_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.url).toBe('https://paymaster.example.test/rpc')
      expect(result.chainId).toBe(BASE_SEPOLIA_CHAIN_ID)
    }
  })

  it('resolvePaymasterForChain() returns chain_mismatch for a different chain', () => {
    const result = resolvePaymasterForChain(OTHER_CHAIN_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('chain_mismatch')
      expect(result.reason).toContain(String(BASE_SEPOLIA_CHAIN_ID))
      expect(result.reason).toContain(String(OTHER_CHAIN_ID))
    }
  })
})

// ---------------------------------------------------------------------------
// 4. PAYMASTER_ENABLED case-insensitive + whitespace
// ---------------------------------------------------------------------------

describe('PAYMASTER_ENABLED edge cases', () => {
  it('accepts "TRUE" (uppercase)', () => {
    process.env.PAYMASTER_ENABLED = 'TRUE'
    expect(isPaymasterEnabled()).toBe(true)
  })

  it('accepts " true " (with whitespace)', () => {
    process.env.PAYMASTER_ENABLED = ' true '
    expect(isPaymasterEnabled()).toBe(true)
  })

  it('rejects "1" (not exactly "true")', () => {
    process.env.PAYMASTER_ENABLED = '1'
    expect(isPaymasterEnabled()).toBe(false)
  })

  it('rejects "yes"', () => {
    process.env.PAYMASTER_ENABLED = 'yes'
    expect(isPaymasterEnabled()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. paymasterChainId — invalid values
// ---------------------------------------------------------------------------

describe('paymasterChainId edge cases', () => {
  it('returns 0 for a non-numeric value', () => {
    process.env.NEXT_PUBLIC_PAYMASTER_CHAIN_ID = 'not-a-number'
    expect(paymasterChainId()).toBe(0)
  })

  it('returns 0 for "0" (chain id 0 is not valid)', () => {
    process.env.NEXT_PUBLIC_PAYMASTER_CHAIN_ID = '0'
    expect(paymasterChainId()).toBe(0)
  })

  it('returns 0 for a negative value', () => {
    process.env.NEXT_PUBLIC_PAYMASTER_CHAIN_ID = '-1'
    expect(paymasterChainId()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. PAYMASTER_CONFIGURE_NOTE export sanity
// ---------------------------------------------------------------------------

describe('PAYMASTER_CONFIGURE_NOTE', () => {
  it('is a non-empty string that names all three env vars', () => {
    expect(typeof PAYMASTER_CONFIGURE_NOTE).toBe('string')
    expect(PAYMASTER_CONFIGURE_NOTE).toContain('PAYMASTER_ENABLED')
    expect(PAYMASTER_CONFIGURE_NOTE).toContain('NEXT_PUBLIC_PAYMASTER_URL')
    expect(PAYMASTER_CONFIGURE_NOTE).toContain('NEXT_PUBLIC_PAYMASTER_CHAIN_ID')
  })
})

// ---------------------------------------------------------------------------
// 7. No throw in any branch (fail-soft law)
// ---------------------------------------------------------------------------

describe('no throw in any branch', () => {
  it('all functions return safely with garbage env values', () => {
    process.env.PAYMASTER_ENABLED = '!!!invalid'
    process.env.NEXT_PUBLIC_PAYMASTER_URL = '  '
    process.env.NEXT_PUBLIC_PAYMASTER_CHAIN_ID = 'NaN'

    expect(() => isPaymasterEnabled()).not.toThrow()
    expect(() => isPaymasterConfigured()).not.toThrow()
    expect(() => isPaymasterPublicConfigured()).not.toThrow()
    expect(() => isPaymasterActiveForChain(BASE_SEPOLIA_CHAIN_ID)).not.toThrow()
    expect(() => paymasterUrl()).not.toThrow()
    expect(() => paymasterChainId()).not.toThrow()
    expect(() => paymasterCapability()).not.toThrow()
    expect(() => resolvePaymasterForChain(BASE_SEPOLIA_CHAIN_ID)).not.toThrow()
  })
})
