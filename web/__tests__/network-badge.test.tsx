/**
 * @file network-badge.test.tsx — the live-network truth chip's three states.
 *
 * NetworkBadgeView is the pure presentational half (the IdentityChipView
 * precedent), so every state renders deterministically under React's static
 * server renderer: supported chain → name + TESTNET tag; a known chain with no
 * router → honest "no payments router" + inline switch buttons; an unknown
 * chain → "Unsupported network" + the same switch buttons. The container
 * renders NOTHING when no wallet is connected. wagmi + Dynamic are mocked so
 * the render is hermetic (the DashboardView precedent).
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const wagmiState = {
  account: { chainId: undefined as number | undefined, isConnected: false },
  configChainId: 5042002,
}
vi.mock('wagmi', () => ({
  useAccount: () => wagmiState.account,
  useChainId: () => wagmiState.configChainId,
}))

vi.mock('@dynamic-labs/sdk-react-core', () => ({
  useDynamicContext: () => ({ primaryWallet: null }),
}))

const { NetworkBadge, NetworkBadgeView } = await import('../components/NetworkBadge')
const { resolveLiveChain, writableChains } = await import('../lib/live-chain')

function renderView(chainId: number): string {
  return renderToStaticMarkup(
    createElement(NetworkBadgeView, {
      live: resolveLiveChain(chainId, true),
      targets: writableChains(),
      switching: null,
      switchError: null,
      onSwitch: () => {},
    }),
  )
}

describe('NetworkBadgeView — supported chain', () => {
  it('names the live chain and tags it TESTNET', () => {
    const html = renderView(5042002)
    expect(html).toContain('data-network-badge="supported"')
    expect(html).toContain('Arc Testnet')
    expect(html).toContain('TESTNET')
    // A healthy chain shows NO switch buttons.
    expect(html).not.toContain('Switch to')
  })
})

describe('NetworkBadgeView — known chain without a router', () => {
  it('says so honestly and offers one switch button per writable chain', () => {
    const html = renderView(300) // zkSync Sepolia: supported chain, no router in this env
    expect(html).toContain('data-network-badge="no-router"')
    expect(html).toContain('no payments router on this network')
    expect(html).toContain('Switch to Arc Testnet')
    expect(html).toContain('Switch to Base Sepolia')
  })
})

describe('NetworkBadgeView — unknown network', () => {
  it('never invents a name or a TESTNET/MAINNET claim for a chain it cannot identify', () => {
    const html = renderView(1)
    expect(html).toContain('data-network-badge="unsupported"')
    expect(html).toContain('Unsupported network (chain 1)')
    expect(html).not.toContain('TESTNET')
    expect(html).not.toContain('MAINNET')
    expect(html).toContain('Switch to Arc Testnet')
  })
})

describe('NetworkBadge container', () => {
  it('renders nothing when no wallet is connected', () => {
    wagmiState.account = { chainId: undefined, isConnected: false }
    const html = renderToStaticMarkup(createElement(NetworkBadge))
    expect(html).toBe('')
  })
})
