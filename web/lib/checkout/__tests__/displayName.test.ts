/**
 * @file displayName.test.ts — the untrusted checkout-name resolver.
 *
 * Pins the visible-word-injection defense on the `/m/{merchantId}` checkout:
 * the `?name=` param + localStorage fallback are attacker-controllable and must
 * be sanitized + bounded before they can render as the checkout header, and the
 * neutral `Merchant #<id>` label is used only when both untrusted sources are
 * empty after sanitizing.
 */
import { describe, expect, it } from 'vitest'

import { resolveCheckoutDisplayName } from '../displayName'
import { MAX_DISPLAY_NAME_CHARS } from '../../branding/store'

describe('resolveCheckoutDisplayName', () => {
  it('uses a clean ?name= param verbatim', () => {
    expect(resolveCheckoutDisplayName('Acme Coffee', null, '42')).toBe('Acme Coffee')
  })

  it('strips tags and stray brackets from the param (no markup reaches the header)', () => {
    expect(
      resolveCheckoutDisplayName('<img src=x onerror=alert(1)>Acme', null, '42'),
    ).toBe('Acme')
    expect(resolveCheckoutDisplayName('Ac<>me', null, '42')).toBe('Acme')
  })

  it('clamps an over-long attacker param to the display-name bound', () => {
    const long = 'A'.repeat(500)
    const out = resolveCheckoutDisplayName(long, null, '42')
    expect(out.length).toBe(MAX_DISPLAY_NAME_CHARS)
  })

  it('collapses whitespace (no giant blank-padded banner)', () => {
    expect(resolveCheckoutDisplayName('Acme      \n\t   Support', null, '42')).toBe('Acme Support')
  })

  it('falls back to the sanitized stored name when the param is absent', () => {
    expect(resolveCheckoutDisplayName(null, 'Stored Cafe', '42')).toBe('Stored Cafe')
    expect(resolveCheckoutDisplayName(undefined, '<b>Stored</b>', '42')).toBe('Stored')
  })

  it('prefers the param over the stored name', () => {
    expect(resolveCheckoutDisplayName('FromParam', 'FromStore', '42')).toBe('FromParam')
  })

  it('falls back to the neutral Merchant #<id> label when both are empty/blank', () => {
    expect(resolveCheckoutDisplayName(null, null, '42')).toBe('Merchant #42')
    expect(resolveCheckoutDisplayName('   ', '', '7')).toBe('Merchant #7')
    // A param that sanitizes to nothing (pure markup) must NOT render empty.
    expect(resolveCheckoutDisplayName('<<>>', null, '9')).toBe('Merchant #9')
  })
})
