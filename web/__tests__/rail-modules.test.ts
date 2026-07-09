/**
 * @file rail-modules.test.ts — the post-registration "what you sit on" card.
 *
 * After a register, the dashboard shows the merchantId + the SHARED module
 * addresses for the chain the seat landed on, read from the generated
 * deployments map (broadcast ground truth). Pins:
 *   - UUPS chains list the PROXY addresses (suffix stripped), never `.impl`
 *     rows or the bare ERC1967Proxy artifact;
 *   - explorer links resolve per chain and are OMITTED (plain text) where no
 *     explorer is known (Arc) — never an invented link;
 *   - an unknown chain yields [] — modules are never fabricated.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RailModulesCard,
  chainDisplayName,
  moduleExplorerUrl,
  sharedModulesFor,
} from '../components/RailModulesCard'
import { MIRROR_ROUTER_ADDRESS } from '../lib/chains'

describe('sharedModulesFor', () => {
  it('Base Sepolia: proxies only, suffix stripped, router at the mirror address', () => {
    const modules = sharedModulesFor(84532)
    expect(modules.length).toBeGreaterThan(0)
    for (const m of modules) {
      expect(m.name.endsWith('.impl')).toBe(false)
      expect(m.name.endsWith('.proxy')).toBe(false)
      expect(m.name).not.toBe('ERC1967Proxy')
    }
    const router = modules.find((m) => m.name === 'Access0x1Router')
    expect(router?.address).toBe(MIRROR_ROUTER_ADDRESS.toLowerCase())
  })

  it('a plain (non-UUPS-split) chain keeps its single-address entries, minus ERC1967Proxy', () => {
    const modules = sharedModulesFor(16602) // 0G Galileo: plain names + one ERC1967Proxy row
    expect(modules.some((m) => m.name === 'Access0x1Router')).toBe(true)
    expect(modules.some((m) => m.name === 'ERC1967Proxy')).toBe(false)
  })

  it('an unrecorded chain yields no modules — never fabricated', () => {
    expect(sharedModulesFor(999999)).toEqual([])
  })
})

describe('moduleExplorerUrl', () => {
  it('resolves the per-chain explorer address url', () => {
    expect(moduleExplorerUrl(84532, '0xabc')).toBe('https://sepolia.basescan.org/address/0xabc')
  })

  it('is undefined where no explorer is known (Arc) — the card renders plain text', () => {
    expect(moduleExplorerUrl(5042002, '0xabc')).toBeUndefined()
  })
})

describe('chainDisplayName', () => {
  it('prefers the app chain registry, then the deployments map, then the honest number', () => {
    expect(chainDisplayName(5042002)).toBe('Arc Testnet')
    expect(chainDisplayName(560048)).toBe('Hoodi') // deployments-only chain
    expect(chainDisplayName(424242)).toBe('chain 424242')
  })
})

describe('RailModulesCard render', () => {
  it('shows the merchant id, the landing chain, and explorer-linked modules', () => {
    const html = renderToStaticMarkup(
      createElement(RailModulesCard, { chainId: 84532, merchantId: '7' }),
    )
    expect(html).toContain('Merchant #7 on Base Sepolia')
    expect(html).toContain('Access0x1Router')
    expect(html).toContain('https://sepolia.basescan.org/address/')
  })

  it('on an unrecorded chain it says so instead of inventing addresses', () => {
    const html = renderToStaticMarkup(
      createElement(RailModulesCard, { chainId: 999999, merchantId: '7' }),
    )
    expect(html).toContain('No recorded module addresses')
  })
})
