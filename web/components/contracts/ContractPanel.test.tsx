/**
 * @file ContractPanel.test.tsx — the generic panel actually RENDERS the full
 * surface of a module from its real ABI (via React's static server renderer,
 * the IdentityChipView precedent), and renders the honest "not on this chain
 * yet" state for a module with no broadcast address. Uses real registry data
 * (Avalanche Fuji, where the mirror router is deployed and Rebates is not).
 *
 * The wallet hook is mocked to a signed-out context — we assert what the panel
 * RENDERS, not what a write does (writes are exercised by the encode/call units).
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@dynamic-labs/sdk-react-core', () => ({
  useDynamicContext: () => ({ primaryWallet: null, setShowAuthFlow: () => {} }),
}))

import { ContractPanel } from './ContractPanel'

const FUJI = 43113 // mirror router deployed; Rebates absent

function render(name: string, chainId = FUJI): string {
  // `name` is a ModuleName at the call sites below; cast keeps the test terse.
  return renderToStaticMarkup(
    createElement(ContractPanel, { name: name as never, chainId }),
  )
}

describe('ContractPanel — a deployed module (Router on Fuji)', () => {
  const out = render('Access0x1Router')

  it('renders the module label + panel hook + short address', () => {
    expect(out).toContain('data-contract-panel="Access0x1Router"')
    expect(out).toContain('Router')
    expect(out).toContain('0xe922') // the mirror router's short address prefix
  })

  it('renders BOTH read and write sections from the ABI', () => {
    expect(out).toContain('Read')
    expect(out).toContain('Write')
    // Real router functions on both sides of the state-mutability split:
    expect(out).toContain('platformFeeBps') // a view read
    expect(out).toContain('registerMerchant') // a write
    expect(out).toContain('payToken') // a write
  })

  it('does not claim "not on this chain" for a deployed module', () => {
    expect(out).not.toContain('not on Avalanche Fuji yet')
  })
})

describe('ContractPanel — an undeployed module (Rebates on Fuji)', () => {
  const out = render('Access0x1Rebates')

  it('renders the honest not-on-this-chain state and no call sections', () => {
    expect(out).toContain('not on Avalanche Fuji yet')
    // No function sections render when there is no address.
    expect(out).not.toContain('>Read<')
    expect(out).not.toContain('>Write<')
  })
})
