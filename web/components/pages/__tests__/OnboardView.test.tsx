/**
 * @file OnboardView.test.tsx — the onboard shell connect-gate.
 *
 * DISCONNECTED → ONE hero connect-gate (a single headline + one ConnectButton +
 * the "what you'll build" line), NOT three empty card boxes each repeating a
 * sign-in prompt. CONNECTED → the three configuration cards.
 *
 * Rendered via React's static server renderer (node env; the FundButton /
 * AskView precedent). `useDynamicContext` is mocked so we can drive both states.
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
}))

const { OnboardView } = await import('../OnboardView')

afterEach(() => {
  wallet.mutable = null
  vi.clearAllMocks()
})

function render(): string {
  return renderToStaticMarkup(createElement(OnboardView))
}

describe('disconnected → single hero connect-gate', () => {
  it('renders exactly ONE connect-gate section, not three card boxes', () => {
    wallet.mutable = null
    const html = render()
    expect(html).toContain('data-onboard-gate="connect"')
    // The configuration cards must NOT be present when disconnected.
    expect(html).not.toContain('What is your business called?')
    expect(html).not.toContain('Who can pay you, and how?')
  })

  it('shows a single "what you’ll build" outcome line', () => {
    wallet.mutable = null
    const html = render()
    expect(html.toLowerCase()).toContain('branded checkout link that accepts usdc')
  })
})

describe('connected → the three configuration cards', () => {
  it('renders the branding + checkout-mode cards (no connect-gate)', () => {
    wallet.mutable = { address: '0x' + '1'.repeat(40) }
    const html = render()
    expect(html).not.toContain('data-onboard-gate="connect"')
    expect(html).toContain('What is your business called?')
    expect(html).toContain('Who can pay you, and how?')
  })
})
