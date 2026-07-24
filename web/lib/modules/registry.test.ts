/**
 * registry.test.ts — pins the module registry's three joins without a browser:
 *  1. the catalog covers exactly the modules that have a committed ABI;
 *  2. address resolution is proxy-aware (returns `.proxy`, never `.impl`) and
 *     honest (null when a module isn't on a chain);
 *  3. the ABI split sorts reads (view/pure) from writes and never leaks a
 *     constructor/error into either.
 */
import { describe, expect, it } from 'vitest'
import { MODULE_ABIS, MODULE_NAMES } from '@/lib/generated/module-abis'
import { MODULE_CATALOG, defaultLabel } from './catalog'
import {
  groupByCategory,
  isDeployedAnywhere,
  isRead,
  listModules,
  liveCount,
  moduleAddressFor,
  splitAbi,
} from './registry'

// Avalanche Fuji (43113) has the full UUPS proxy set in the broadcast map; the
// mirror router proxy is the canonical CREATE3 address.
const FUJI = 43113
const MIRROR_ROUTER = '0xe92244e3368561faf21648146511dede3a475eb5'
const ROUTER_IMPL = '0x3336ec82d865e8bd1f9054856ac22b45a71207db'

describe('catalog ⇄ ABIs coverage', () => {
  it('every catalog module has a committed ABI', () => {
    for (const meta of MODULE_CATALOG) {
      expect(MODULE_ABIS[meta.name], `${meta.name} ABI`).toBeDefined()
    }
  })

  it('covers every ABI exactly once (no gaps, no dupes) — guaranteed by auto-derivation', () => {
    const catalogNames = MODULE_CATALOG.map((m) => m.name).sort()
    expect(catalogNames).toEqual([...MODULE_NAMES].sort())
    expect(new Set(catalogNames).size).toBe(catalogNames.length)
  })

  it('surfaces newly-built contracts (the resolver + v4 hook) automatically', () => {
    const names = MODULE_CATALOG.map((m) => m.name)
    expect(names).toContain('Access0x1PaymentResolver')
    expect(names).toContain('Access0x1SwapReceiptHook')
  })
})

describe('auto-derivation — dynamic catalog', () => {
  it('defaultLabel strips the Access0x1 prefix and de-camelCases', () => {
    expect(defaultLabel('Access0x1FooBar')).toBe('Foo bar')
    expect(defaultLabel('HouseTokenFactory')).toBe('House token factory')
    expect(defaultLabel('Access0x1NFTVault')).toBe('Nft vault')
  })

  it('every catalog entry carries a non-empty label + blurb (curated or default)', () => {
    for (const m of MODULE_CATALOG) {
      expect(m.label.length, `${m.name} label`).toBeGreaterThan(0)
      expect(m.blurb.length, `${m.name} blurb`).toBeGreaterThan(0)
    }
  })

  it('marks a built-but-undeployed contract as preview, and a deployed one as not', () => {
    // The resolver + hook are built this sprint but broadcast to no chain yet.
    expect(isDeployedAnywhere('Access0x1PaymentResolver')).toBe(false)
    expect(isDeployedAnywhere('Access0x1SwapReceiptHook')).toBe(false)
    // The router is mirrored across the testnets.
    expect(isDeployedAnywhere('Access0x1Router')).toBe(true)
  })

  it('listModules flags preview modules (deployed nowhere)', () => {
    const modules = listModules(FUJI)
    const resolver = modules.find((m) => m.meta.name === 'Access0x1PaymentResolver')
    const router = modules.find((m) => m.meta.name === 'Access0x1Router')
    expect(resolver?.preview).toBe(true)
    expect(router?.preview).toBe(false)
  })
})

describe('moduleAddressFor — proxy-aware + honest', () => {
  it('resolves the live PROXY address on a mirror chain', () => {
    expect(moduleAddressFor(FUJI, 'Access0x1Router')?.toLowerCase()).toBe(MIRROR_ROUTER)
  })

  it('never returns the implementation address', () => {
    expect(moduleAddressFor(FUJI, 'Access0x1Router')?.toLowerCase()).not.toBe(ROUTER_IMPL)
  })

  it('returns null for a module not deployed on the chain', () => {
    // Rebates has an ABI but no broadcast entry anywhere yet.
    expect(moduleAddressFor(FUJI, 'Access0x1Rebates')).toBeNull()
  })

  it('returns null for an unknown chain', () => {
    expect(moduleAddressFor(999999, 'Access0x1Router')).toBeNull()
  })
})

describe('splitAbi', () => {
  const parts = splitAbi(MODULE_ABIS['Access0x1Router'])

  it('has both reads and writes for the router', () => {
    expect(parts.reads.length).toBeGreaterThan(0)
    expect(parts.writes.length).toBeGreaterThan(0)
    expect(parts.events.length).toBeGreaterThan(0)
  })

  it('every read is view/pure and every write is not', () => {
    expect(parts.reads.every(isRead)).toBe(true)
    expect(parts.writes.some(isRead)).toBe(false)
  })

  it('sorts functions by name (stable panel order)', () => {
    const names = parts.reads.map((f) => f.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})

describe('listModules / grouping', () => {
  const modules = listModules(FUJI)

  it('lists the complete catalog for a chain', () => {
    expect(modules.length).toBe(MODULE_CATALOG.length)
  })

  it('marks the router live and Rebates not-on-chain', () => {
    const router = modules.find((m) => m.meta.name === 'Access0x1Router')
    const rebates = modules.find((m) => m.meta.name === 'Access0x1Rebates')
    expect(router?.address).not.toBeNull()
    expect(rebates?.address).toBeNull()
    expect(liveCount(modules)).toBeGreaterThan(0)
    expect(liveCount(modules)).toBeLessThan(modules.length)
  })

  it('groups by category, non-empty groups only', () => {
    const groups = groupByCategory(modules)
    expect(groups.length).toBeGreaterThan(0)
    expect(groups.every((g) => g.modules.length > 0)).toBe(true)
  })
})
