import { describe, it, expect, afterEach } from 'vitest'
import {
  getRouterAddress,
  MIRROR_ROUTER_ADDRESS,
  MIRROR_SUPPORTED_CHAIN_IDS,
} from '../lib/chains.js'

/**
 * "Make everything mirrored by default": the CREATE3 mirror router is the
 * zero-config default on every mirrored chain (an integrator needs no per-chain
 * router env), while a non-mirrored/unconfigured chain still fails loud — never a
 * guessed address.
 */
describe('mirror router default', () => {
  afterEach(() => {
    for (const id of MIRROR_SUPPORTED_CHAIN_IDS) {
      delete process.env[`NEXT_PUBLIC_ROUTER_ADDRESS_${id}`]
    }
  })

  it('resolves the CREATE3 mirror for every mirrored chain with no per-chain env', () => {
    for (const id of MIRROR_SUPPORTED_CHAIN_IDS) {
      delete process.env[`NEXT_PUBLIC_ROUTER_ADDRESS_${id}`]
      expect(getRouterAddress(id)).toBe(MIRROR_ROUTER_ADDRESS)
    }
  })

  it('fails loud on a non-mirrored, unconfigured chain (never a guessed router)', () => {
    expect(() => getRouterAddress(9_999_999)).toThrow()
  })

  it('lets a per-chain env override win over the mirror default', () => {
    // Use a non-Base mirrored id (Base 84532 reads a module-load literal); the
    // others read the computed server-side key at call time.
    const id = 5042002 // Arc
    const override = '0x00000000000000000000000000000000000000bb'
    process.env[`NEXT_PUBLIC_ROUTER_ADDRESS_${id}`] = override
    expect(getRouterAddress(id)).toBe(override)
  })
})
