/**
 * @file paymentLink.test.ts — the merchant's shared checkout link carries their price.
 *
 * Pins the fix for the wizard's "Payment link"/QR silently falling back to
 * CheckoutView's generic $29.00 whenever `?amount=` was missing: the built
 * link must always carry the merchant's own `priceUsd`, and must be empty
 * (never a malformed URL) while `origin` hasn't resolved yet.
 */
import { describe, expect, it } from 'vitest'

import { buildMerchantPaymentLink } from '../paymentLink'

describe('buildMerchantPaymentLink', () => {
  it('carries the merchant price as ?amount=', () => {
    expect(buildMerchantPaymentLink('https://access0x1.click', 42n, '29.00')).toBe(
      'https://access0x1.click/m/42?amount=29.00',
    )
  })

  it('reflects a non-default price exactly (no silent $29.00 fallback)', () => {
    expect(buildMerchantPaymentLink('https://access0x1.click', 7n, '150.00')).toBe(
      'https://access0x1.click/m/7?amount=150.00',
    )
  })

  it('returns empty (not a malformed relative URL) while origin is unresolved', () => {
    expect(buildMerchantPaymentLink('', 42n, '29.00')).toBe('')
  })
})
