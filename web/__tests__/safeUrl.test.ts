/**
 * @file safeUrl.test.ts — the open-redirect / `javascript:`-URI guard (C-1 / O-11).
 *
 * Proves `safeReturnUrl` (and its boolean twin `isSafeReturnUrl`) is a strict
 * https:-only allowlist: the dangerous schemes a `?return_url=`/`redirectUrl`
 * attacker reaches for — `javascript:`, `data:`, plain `http:`, protocol-relative
 * `//evil`, and relative paths — are all REJECTED, while a clean cross-origin
 * `https:` URL is allowed through (the legitimate "Return to merchant" case).
 */
import { describe, expect, it } from 'vitest'

import { isSafeReturnUrl, safeReturnUrl } from '../lib/safeUrl'

describe('safeReturnUrl — rejects the attack schemes', () => {
  it('rejects a javascript: URI (XSS on the payment-confirmed page)', () => {
    expect(safeReturnUrl('javascript:alert(document.cookie)')).toBeUndefined()
    expect(isSafeReturnUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects a data: URI', () => {
    expect(safeReturnUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(isSafeReturnUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false)
  })

  it('rejects plain http: (downgrade / clear-text return link)', () => {
    expect(safeReturnUrl('http://merchant.example/thanks')).toBeUndefined()
    expect(isSafeReturnUrl('http://merchant.example/thanks')).toBe(false)
  })

  it('rejects a protocol-relative //evil-origin handoff', () => {
    // `//evil.example` would inherit the page scheme in a browser href — fail closed.
    expect(safeReturnUrl('//evil.example/phish')).toBeUndefined()
    expect(isSafeReturnUrl('//evil.example/phish')).toBe(false)
  })

  it('rejects a relative path (no base ⇒ unparseable ⇒ dropped)', () => {
    expect(safeReturnUrl('/thanks')).toBeUndefined()
    expect(safeReturnUrl('thanks?x=1')).toBeUndefined()
    expect(isSafeReturnUrl('/thanks')).toBe(false)
  })

  it('rejects a scheme-spoof with leading whitespace / mixed case', () => {
    // `safeReturnUrl` trims, and `new URL` lowercases the protocol, so these
    // normalize to javascript: and are still rejected.
    expect(safeReturnUrl('  JavaScript:alert(1)')).toBeUndefined()
    expect(safeReturnUrl('\tjava\nscript:alert(1)')).toBeUndefined()
  })

  it('rejects non-string / empty input, returning the fallback', () => {
    expect(safeReturnUrl(undefined)).toBeUndefined()
    expect(safeReturnUrl(null)).toBeUndefined()
    expect(safeReturnUrl(42)).toBeUndefined()
    expect(safeReturnUrl('')).toBeUndefined()
    expect(safeReturnUrl('   ')).toBeUndefined()
    expect(isSafeReturnUrl(undefined)).toBe(false)
    expect(isSafeReturnUrl('')).toBe(false)
  })
})

describe('safeReturnUrl — allows a clean https: URL', () => {
  it('passes a cross-origin https: URL through (the legit return link)', () => {
    expect(safeReturnUrl('https://merchant.example/thanks')).toBe(
      'https://merchant.example/thanks',
    )
    expect(isSafeReturnUrl('https://merchant.example/thanks')).toBe(true)
  })

  it('preserves path, query, and fragment on an https: URL', () => {
    expect(safeReturnUrl('https://shop.example/order?id=42#done')).toBe(
      'https://shop.example/order?id=42#done',
    )
  })

  it('trims surrounding whitespace before validating', () => {
    expect(safeReturnUrl('  https://merchant.example/thanks  ')).toBe(
      'https://merchant.example/thanks',
    )
  })
})

describe('safeReturnUrl — the fallback parameter', () => {
  it('returns the supplied safe fallback when the candidate is rejected', () => {
    const home = 'https://access0x1.xyz/'
    expect(safeReturnUrl('javascript:alert(1)', home)).toBe(home)
    expect(safeReturnUrl('http://evil.example', home)).toBe(home)
    expect(safeReturnUrl(undefined, home)).toBe(home)
  })

  it('prefers a valid candidate over the fallback', () => {
    const home = 'https://access0x1.xyz/'
    expect(safeReturnUrl('https://merchant.example/thanks', home)).toBe(
      'https://merchant.example/thanks',
    )
  })
})
