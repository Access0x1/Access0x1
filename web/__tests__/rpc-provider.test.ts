/**
 * @file rpc-provider.test.ts — the per-chain RPC provider override (QuickNode & friends).
 *
 * Pins that an operator can point ANY supported chain's server-side reads at a dedicated
 * endpoint via `RPC_URL_<chainId>` (e.g. a QuickNode URL), and that a blank/unset override
 * falls through to the chain's own default — never an empty URL.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { baseSepolia } from 'viem/chains'
import { getRpcUrl } from '@/lib/chains'

const KEY = `RPC_URL_${baseSepolia.id}`

afterEach(() => {
  delete process.env[KEY]
})

describe('getRpcUrl — provider override', () => {
  it('returns the QuickNode override when RPC_URL_<chainId> is set', () => {
    process.env[KEY] = 'https://example.base-sepolia.quiknode.pro/token/'
    expect(getRpcUrl(baseSepolia.id)).toBe('https://example.base-sepolia.quiknode.pro/token/')
  })

  it('falls through to the chain default when the override is unset', () => {
    expect(getRpcUrl(baseSepolia.id)).toBe(baseSepolia.rpcUrls.default.http[0])
  })

  it('treats a blank override as unset (never an empty URL)', () => {
    process.env[KEY] = '   '
    expect(getRpcUrl(baseSepolia.id)).toBe(baseSepolia.rpcUrls.default.http[0])
  })
})
