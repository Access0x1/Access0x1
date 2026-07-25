/**
 * price.test.ts — a merchant's checkout link charges the merchant's price.
 *
 * The regression these pin reached real customers: the done-screen link and embed
 * hardcoded `29.00`, and `SlugCheckoutView` fell back to the same literal, while no
 * field existed anywhere in the product to set a price. Someone selling a $25 haircut
 * handed out a QR that charged $29.
 *
 * `lib/checkout/paymentLink.ts` already warned about exactly this failure — "every
 * buyer who scans it gets charged the generic fallback instead of the price the
 * merchant just set" — and the warning had been heeded for `/m/` links and never for
 * `/c/` ones. So the sharpest test here is the last one: no literal 29 survives.
 */
import { describe, expect, it } from 'vitest'

import { sanitizePriceUsd, upsertBranding } from '../store'

const TENANT = '0x' + '1'.repeat(40)

describe('sanitizePriceUsd', () => {
  it('normalizes a usable price to two decimals', () => {
    expect(sanitizePriceUsd('25')).toBe('25.00')
    expect(sanitizePriceUsd('25.5')).toBe('25.50')
    expect(sanitizePriceUsd(12.345)).toBe('12.35')
  })

  it('treats an unusable price as NO price, never as a number nobody chose', () => {
    // Every one of these must become null. Coercing any of them to a default is how
    // a customer gets charged something the merchant never typed.
    for (const bad of ['', '   ', 'free', '-5', '0', Number.NaN, Infinity, null, undefined]) {
      expect(sanitizePriceUsd(bad)).toBeNull()
    }
  })

  it('rejects an absurd figure rather than putting it in a customer-facing link', () => {
    expect(sanitizePriceUsd('999999999999')).toBeNull()
  })
})

describe('the branding row carries the price', () => {
  it('stores the merchant’s own price', () => {
    const row = upsertBranding({ tenantId: TENANT, displayName: 'Joe’s Barbershop', priceUsd: '25' })
    expect(row.priceUsd).toBe('25.00')
  })

  it('defaults to NO price rather than to a number', () => {
    const row = upsertBranding({ tenantId: '0x' + '2'.repeat(40), displayName: 'No Price Shop' })
    expect(row.priceUsd).toBeNull()
  })

  it('keeps an existing price when a later save omits it', () => {
    const t = '0x' + '3'.repeat(40)
    upsertBranding({ tenantId: t, displayName: 'Keeps Price', priceUsd: '9.99' })
    // Editing only the description must not silently wipe what customers are charged.
    const after = upsertBranding({ tenantId: t, displayName: 'Keeps Price', description: 'hi' })
    expect(after.priceUsd).toBe('9.99')
  })

  it('lets a merchant clear the price explicitly', () => {
    const t = '0x' + '4'.repeat(40)
    upsertBranding({ tenantId: t, displayName: 'Clears', priceUsd: '5.00' })
    const after = upsertBranding({ tenantId: t, displayName: 'Clears', priceUsd: null })
    expect(after.priceUsd).toBeNull()
  })

  it('does not resurrect the hardcoded 29.00 anywhere in the row', () => {
    const row = upsertBranding({ tenantId: '0x' + '5'.repeat(40), displayName: 'No Ghost Price' })
    expect(JSON.stringify(row)).not.toContain('29.00')
  })
})
