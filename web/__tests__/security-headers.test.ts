/**
 * @file security-headers.test.ts — the HTTP security-header floor (red-report R-3).
 *
 * The web app had NO `headers()` block at all: no CSP, no `X-Frame-Options`, no
 * `nosniff`, no HSTS, no `Referrer-Policy`, no `Permissions-Policy`. Absent a CSP,
 * any surviving XSS (e.g. an SVG-logo CSS beacon, R-4) runs with no backstop, and
 * absent frame options the checkout can be silently iframed (clickjacking).
 *
 * These tests pin that the baseline set is PRESENT and complete, and that
 * `nextConfig.headers()` applies the whole set to every route. They assert
 * presence + the security-critical values; they do not over-specify the exact CSP
 * source list (that may evolve as origins are added) beyond the directives that
 * make it a real defense.
 */
import { describe, expect, it } from 'vitest'

import nextConfig, { SECURITY_HEADERS } from '../next.config'

/** The header names R-3 requires on every response. */
const REQUIRED_KEYS = [
  'Content-Security-Policy',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Strict-Transport-Security',
  'Referrer-Policy',
  'Permissions-Policy',
] as const

function byKey(headers: ReadonlyArray<{ key: string; value: string }>): Map<string, string> {
  return new Map(headers.map((h) => [h.key, h.value]))
}

describe('SECURITY_HEADERS — the baseline set (R-3)', () => {
  const map = byKey(SECURITY_HEADERS)

  it('includes every required security header', () => {
    for (const key of REQUIRED_KEYS) {
      expect(map.has(key), `missing ${key}`).toBe(true)
    }
  })

  it('sets the security-critical values verbatim', () => {
    expect(map.get('X-Frame-Options')).toBe('DENY')
    expect(map.get('X-Content-Type-Options')).toBe('nosniff')
    expect(map.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  it('HSTS has a long max-age and covers subdomains', () => {
    const hsts = map.get('Strict-Transport-Security') ?? ''
    expect(hsts).toMatch(/max-age=\d{7,}/) // >= ~4 months, in seconds
    expect(hsts).toMatch(/includeSubDomains/)
  })

  it('Permissions-Policy denies powerful features the checkout never needs', () => {
    const pp = map.get('Permissions-Policy') ?? ''
    expect(pp).toMatch(/camera=\(\)/)
    expect(pp).toMatch(/microphone=\(\)/)
    expect(pp).toMatch(/geolocation=\(\)/)
  })

  it('CSP blocks framing and plugin/object execution, and locks base/form targets', () => {
    const csp = map.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("default-src 'self'")
  })
})

describe('nextConfig.headers() — applied to every route (R-3)', () => {
  it('exposes an async headers() function', () => {
    expect(typeof nextConfig.headers).toBe('function')
  })

  it('returns the full SECURITY_HEADERS set scoped to all paths', async () => {
    const rules = await nextConfig.headers!()
    expect(Array.isArray(rules)).toBe(true)
    expect(rules.length).toBeGreaterThan(0)

    const wildcard = rules.find((r) => r.source === '/:path*')
    expect(wildcard, 'no rule applies headers to every path').toBeTruthy()

    const applied = byKey(wildcard!.headers as Array<{ key: string; value: string }>)
    for (const key of REQUIRED_KEYS) {
      expect(applied.get(key), `header ${key} not applied to all paths`).toBe(
        byKey(SECURITY_HEADERS).get(key),
      )
    }
  })
})
