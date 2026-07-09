/**
 * @file DashboardView.test.tsx — the dashboard's "switch on payments" honesty.
 *
 * The dashboard must NEVER claim "✓ Payments are on" before the server BIND
 * (attachOnChain) actually succeeds — otherwise the merchant sees "live" while
 * the customer page still reads "hasn't switched on payments yet" (law #4: truth
 * in copy; law #5: money paths never claim success they didn't deliver).
 *
 * The test env is node-only with React's static server renderer (the
 * OnboardView / FundButton precedent) — effects do NOT fire and post-callback
 * async state cannot be driven here, so the FLIP decision itself is pinned as a
 * pure function in `lib/branding/__tests__/attachDecision.test.ts`. This file
 * pins the COMPONENT invariant that survives a render: a freshly-mounted
 * dashboard never renders the live confirmation copy. `useDynamicContext` /
 * `getAuthToken` and the branding client are mocked so the render is hermetic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const wallet = { mutable: null as null | { address: string } }

vi.mock('@dynamic-labs/sdk-react-core', () => ({
  useDynamicContext: () => ({
    primaryWallet: wallet.mutable,
    setShowAuthFlow: () => {},
    handleLogOut: () => {},
  }),
  getAuthToken: () => undefined,
}))

// The view now mounts NetworkBadge (useLiveChain → wagmi). Mock the wagmi
// hooks — the node test env has no WagmiProvider; a disconnected state keeps
// the badge dormant and the dashboard on the default chain, as before.
vi.mock('wagmi', () => ({
  useAccount: () => ({ chainId: undefined, isConnected: false }),
  useChainId: () => 5042002,
}))

// Keep the branding client hermetic: by default a failed attach (so any code
// that wrongly flipped to "payments on" would be caught), and a pending row.
const attachOnChainMock = vi.fn(async (..._args: unknown[]) => ({ ok: false, error: 'nope' }))
vi.mock('@/lib/branding/client', () => ({
  attachOnChain: (...args: unknown[]) => attachOnChainMock(...args),
  loadBrandingStatus: async () => ({ status: 'empty' }),
}))

const { DashboardView } = await import('../DashboardView')

afterEach(() => {
  wallet.mutable = null
  vi.clearAllMocks()
})

function render(): string {
  return renderToStaticMarkup(createElement(DashboardView))
}

describe('DashboardView — never claims payments on before the bind', () => {
  it('a freshly-mounted connected dashboard does NOT render the live confirmation', () => {
    wallet.mutable = { address: '0x' + '1'.repeat(40) }
    const html = render()
    // The honesty guard: no "Payments are on" copy until a bind succeeds.
    expect(html).not.toContain('Payments are on')
    expect(html).not.toContain('Your checkout link is live')
  })

  it('disconnected dashboard also never shows the live confirmation', () => {
    wallet.mutable = null
    const html = render()
    expect(html).not.toContain('Payments are on')
  })
})
