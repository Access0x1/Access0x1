/**
 * @file merchant-identity.test.tsx — the checkout merchant-identity line.
 *
 * Runs in the vitest `node` environment via React's static server renderer (the
 * TokenPicker precedent). The async ENSIP-19 read lives in the outer component's
 * effect (covered by ens.test.ts via verifiedPrimaryName); here we pin the PURE
 * presentational view, which decides verified-name vs address-fallback from a
 * prop — so both states are deterministic without a DOM / effects:
 *   - a verified name shows "Paying <name>" with the verified check,
 *   - null name falls back to the TRUNCATED ADDRESS (never a fabricated name),
 *   - a non-address payout is shown unreshaped (we never guess a shape).
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MerchantIdentityView, truncateAddress } from '../components/MerchantIdentity'

const PAYOUT = '0x7d3a48269416507e6d207a9449e7800971823ffa'

const render = (payout: string, name: string | null): string =>
  renderToStaticMarkup(createElement(MerchantIdentityView, { payout, name }))

describe('truncateAddress', () => {
  it('shortens a 0x address to head…tail', () => {
    expect(truncateAddress(PAYOUT)).toBe('0x7d3a…3ffa')
  })
  it('leaves a non-address unchanged (never reshapes what it does not recognize)', () => {
    expect(truncateAddress('acme.eth')).toBe('acme.eth')
  })
})

describe('MerchantIdentityView — verified name', () => {
  it('shows "Paying <name>" with the verified check when a name is provided', () => {
    const out = render(PAYOUT, 'acme.eth')
    expect(out).toContain('Paying')
    expect(out).toContain('acme.eth')
    expect(out).toContain('data-verified="true"')
    // The check carries an accessible label, the visible marker of a real verify.
    expect(out).toContain('ENS verified')
    // The raw address is NOT shown when a verified name is present.
    expect(out).not.toContain(truncateAddress(PAYOUT))
  })
})

describe('MerchantIdentityView — address fallback', () => {
  it('falls back to the truncated address when name is null (no fabrication)', () => {
    const out = render(PAYOUT, null)
    expect(out).toContain('Paying')
    expect(out).toContain(truncateAddress(PAYOUT))
    expect(out).toContain('data-verified="false"')
    // No verified check is shown without a real name.
    expect(out).not.toContain('ENS verified')
  })

  it('treats an empty-string name as no name (still the address fallback)', () => {
    const out = render(PAYOUT, '')
    expect(out).toContain('data-verified="false"')
    expect(out).toContain(truncateAddress(PAYOUT))
  })
})
