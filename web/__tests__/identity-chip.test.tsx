/**
 * @file identity-chip.test.tsx — the signed-in identity panel's presentation.
 *
 * Runs in the vitest `node` env via React's static server renderer (the
 * MerchantIdentityView precedent). The async primary-name read lives in the
 * outer IdentityChip's hook (covered by usePrimaryEnsName.test.ts); here we pin
 * the PURE view, which decides primary-name-vs-account from a prop:
 *   - a recognized primary name leads as the bold line, with the account label
 *     demoted beneath it (the user sees their OWN name, the way they set it),
 *   - null name keeps the account label as the primary line (prior behavior),
 *   - the wallet provenance line + "Sign out" are always present, and the
 *     embedded case additionally offers "Use your own wallet instead".
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { IdentityChipView } from '../components/IdentityChip'

const ADDRESS = '0x7d3a48269416507e6d207a9449e7800971823ffa'
const SHORT = '0x7d3a…3ffa'
const noop = () => {}

function render(props: Partial<Parameters<typeof IdentityChipView>[0]>): string {
  return renderToStaticMarkup(
    createElement(IdentityChipView, {
      address: ADDRESS,
      account: 'merchant@example.com',
      primaryName: null,
      isEmbedded: true,
      connectorName: 'Wallet',
      onUseOwnWallet: noop,
      onSignOut: noop,
      ...props,
    }),
  )
}

describe('IdentityChipView — recognized primary name', () => {
  it('leads with the primary name and demotes the account label beneath it', () => {
    const out = render({ primaryName: 'rensley.eth', account: 'merchant@example.com' })
    expect(out).toContain('data-primary-name="true"')
    expect(out).toContain('rensley.eth')
    // The account label is still shown (as the secondary line), so the user knows
    // which email/wallet this is.
    expect(out).toContain('merchant@example.com')
  })

  it('treats an empty-string primary name as no name (account leads)', () => {
    const out = render({ primaryName: '', account: 'merchant@example.com' })
    expect(out).toContain('data-primary-name="false"')
  })
})

describe('IdentityChipView — no primary name (prior behavior)', () => {
  it('keeps the account label as the primary line', () => {
    const out = render({ primaryName: null, account: 'merchant@example.com' })
    expect(out).toContain('data-primary-name="false"')
    expect(out).toContain('merchant@example.com')
  })
})

describe('IdentityChipView — provenance + controls (always present)', () => {
  it('shows the embedded-wallet provenance + "use your own wallet" + sign out', () => {
    const out = render({ isEmbedded: true, primaryName: 'rensley.eth' })
    expect(out).toContain('created for this account')
    expect(out).toContain(SHORT)
    expect(out).toContain('Use your own wallet instead')
    expect(out).toContain('Sign out')
  })

  it('names an external connector and omits the "use your own wallet" nudge', () => {
    const out = render({ isEmbedded: false, connectorName: 'MetaMask', primaryName: null })
    expect(out).toContain('Your wallet — MetaMask')
    expect(out).toContain(SHORT)
    expect(out).toContain('Sign out')
    expect(out).not.toContain('Use your own wallet instead')
  })
})
