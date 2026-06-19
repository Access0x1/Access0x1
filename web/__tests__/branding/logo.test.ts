/**
 * logo.test.ts — the SVG SANITIZER + raster→inline-SVG conversion (ADR unit 3).
 *
 * Security-critical: a merchant-supplied SVG is rendered inside the MetaMask
 * Snap's `Image` and on the hosted checkout. These tests pin that NOTHING
 * executable survives sanitization (scripts, event handlers, javascript: URIs,
 * foreignObject, DOCTYPE/ENTITY, remote refs), that rasters are wrapped inertly,
 * and that the monogram + brand-color defaults are safe.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BRAND_COLOR,
  LogoError,
  monogramSvg,
  normalizeBrandColor,
  rasterDataUriToSvg,
  sanitizeSvg,
  sanitizeSvgLogo,
  scaleSvg,
  toInlineSvgLogo,
} from '@/lib/branding/logo'

describe('sanitizeSvg — strips all executable / fetching content', () => {
  it('removes <script> blocks', () => {
    const dirty = '<svg><script>alert(1)</script><rect/></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toMatch(/<script/i)
    expect(clean).toContain('<rect')
  })

  it('removes self-closing / bare <script ...> tags', () => {
    const clean = sanitizeSvg('<svg><script src="x.js"/></svg>')
    expect(clean).not.toMatch(/<script/i)
  })

  it('removes on* event-handler attributes (double, single, bare quotes)', () => {
    const clean = sanitizeSvg(
      `<svg onload="evil()" onclick='x()'><rect onmouseover=y /></svg>`,
    )
    expect(clean).not.toMatch(/\son[a-z]+\s*=/i)
  })

  it('removes javascript: URIs', () => {
    const clean = sanitizeSvg('<svg><a href="javascript:alert(1)">x</a></svg>')
    expect(clean).not.toMatch(/javascript:/i)
  })

  it('removes <foreignObject> (HTML-injection vector)', () => {
    const clean = sanitizeSvg(
      '<svg><foreignObject><body onload="x"></body></foreignObject><rect/></svg>',
    )
    expect(clean).not.toMatch(/foreignObject/i)
    expect(clean).not.toMatch(/onload/i)
  })

  it('removes DOCTYPE / ENTITY (XXE / billion-laughs)', () => {
    const clean = sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg><rect/></svg>')
    expect(clean).not.toMatch(/DOCTYPE/i)
    expect(clean).not.toMatch(/ENTITY/i)
  })

  it('strips remote href/xlink:href but KEEPS data: refs (raster wrapping)', () => {
    const clean = sanitizeSvg(
      '<svg><use xlink:href="https://evil/x.svg"/><image href="data:image/png;base64,AAAA"/></svg>',
    )
    expect(clean).not.toMatch(/https:\/\/evil/)
    expect(clean).toContain('data:image/png;base64,AAAA')
  })

  it('survives nested re-introduction (repeated scrub until stable)', () => {
    // "<scr<script>ipt>" collapses to "<script>" after one pass — must be caught.
    const clean = sanitizeSvg('<svg><scr<script></script>ipt>alert(1)</script><rect/></svg>')
    expect(clean).not.toMatch(/<script/i)
  })

  it('removes <style> blocks carrying a CSS url() / @font-face beacon (R-4)', () => {
    const dirty =
      '<svg><style>@font-face{font-family:x;src:url(https://attacker.example/beacon.woff)}' +
      'rect{fill:url(https://attacker.example/track.png)}</style><rect/></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toMatch(/<style/i)
    expect(clean).not.toMatch(/@font-face/i)
    expect(clean).not.toMatch(/attacker\.example/)
    expect(clean).toContain('<rect')
  })

  it('removes self-closing / bare <style ...> tags', () => {
    const clean = sanitizeSvg('<svg><style type="text/css"/><rect/></svg>')
    expect(clean).not.toMatch(/<style/i)
    expect(clean).toContain('<rect')
  })

  it('removes inline style= attributes carrying a CSS url() beacon (R-4)', () => {
    const clean = sanitizeSvg(
      `<svg><rect style="fill:url(https://attacker.example/track.png)"/>` +
        `<circle style='background:url(https://attacker.example/b.gif)'/></svg>`,
    )
    expect(clean).not.toMatch(/\sstyle\s*=/i)
    expect(clean).not.toMatch(/attacker\.example/)
    expect(clean).toContain('<rect')
    expect(clean).toContain('<circle')
  })

  it('removes a bare (unquoted) style= attribute', () => {
    const clean = sanitizeSvg('<svg><rect style=fill:red /></svg>')
    expect(clean).not.toMatch(/\sstyle\s*=/i)
  })
})

describe('sanitizeSvgLogo — rejects surviving <style> / style= (belt-and-suspenders)', () => {
  it('strips a <style> beacon and still validates as a clean svg', () => {
    const { svg } = sanitizeSvgLogo(
      '<svg viewBox="0 0 10 10"><style>rect{fill:url(https://attacker.example/x)}</style><rect/></svg>',
    )
    expect(svg).not.toMatch(/<style/i)
    expect(svg).not.toMatch(/attacker\.example/)
  })
})

describe('sanitizeSvgLogo — validates a clean single <svg>', () => {
  it('accepts a clean svg', () => {
    const { svg, kind } = sanitizeSvgLogo('<svg viewBox="0 0 10 10"><circle/></svg>')
    expect(kind).toBe('svg')
    expect(svg).toMatch(/^<svg/i)
  })

  it('rejects an empty input', () => {
    expect(() => sanitizeSvgLogo('   ')).toThrow(LogoError)
  })

  it('rejects a non-svg blob', () => {
    expect(() => sanitizeSvgLogo('<div>not svg</div>')).toThrow(LogoError)
  })

  it('rejects an oversize svg', () => {
    const huge = '<svg>' + 'a'.repeat(300 * 1024) + '</svg>'
    expect(() => sanitizeSvgLogo(huge)).toThrow(LogoError)
  })
})

describe('scaleSvg — resizes AND re-sanitizes the post-processed string (R-4)', () => {
  it('overrides width/height to the target pixel box', () => {
    const sized = scaleSvg('<svg width="256" height="256"><rect/></svg>', 56)
    expect(sized).toContain('width="56"')
    expect(sized).toContain('height="56"')
    expect(sized).not.toContain('256')
  })

  it('re-strips a <style> url() beacon that survived in the stored string', () => {
    // A logo string that (e.g. via an older store row) still carries a CSS beacon
    // must NOT reach the DOM through scaleSvg's raw string edit — it re-sanitizes.
    const stored =
      '<svg width="256" height="256"><style>rect{fill:url(https://attacker.example/x)}</style><rect/></svg>'
    const sized = scaleSvg(stored, 40)
    expect(sized).not.toMatch(/<style/i)
    expect(sized).not.toMatch(/attacker\.example/)
    expect(sized).toContain('width="40"')
  })

  it('re-strips a script reintroduced into the stored string', () => {
    const sized = scaleSvg('<svg width="10" height="10"><script>alert(1)</script><rect/></svg>', 56)
    expect(sized).not.toMatch(/<script/i)
  })

  it('is idempotent on an already-clean, already-sized svg', () => {
    const clean = '<svg width="56" height="56"><rect/></svg>'
    expect(scaleSvg(clean, 56)).toBe(clean)
  })
})

describe('rasterDataUriToSvg — wraps a raster inertly', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  it('wraps a png data-uri into an <svg><image>', () => {
    const { svg, kind } = rasterDataUriToSvg(PNG)
    expect(kind).toBe('raster')
    expect(svg).toMatch(/^<svg/i)
    expect(svg).toContain('<image')
    expect(svg).toContain('data:image/png;base64,')
  })

  it('rejects a non-data-uri', () => {
    expect(() => rasterDataUriToSvg('https://example/logo.png')).toThrow(LogoError)
  })

  it('rejects an unsupported mime', () => {
    expect(() => rasterDataUriToSvg('data:text/html;base64,PGgxPng=')).toThrow(LogoError)
  })
})

describe('toInlineSvgLogo — single entry point', () => {
  it('routes svg markup to the svg sanitizer', () => {
    expect(toInlineSvgLogo('<svg><rect/></svg>').kind).toBe('svg')
  })
  it('routes a data-uri to the raster wrapper', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    expect(toInlineSvgLogo(PNG).kind).toBe('raster')
  })
  it('rejects junk', () => {
    expect(() => toInlineSvgLogo('just text')).toThrow(LogoError)
  })
})

describe('monogramSvg — skip-logo default', () => {
  it('uses initials of up to two words', () => {
    const { svg } = monogramSvg("Joe's Barbershop", '#123456')
    expect(svg).toContain('>JB<')
    expect(svg).toContain('#123456')
  })
  it('escapes any markup in the name (no injection via initials)', () => {
    const { svg } = monogramSvg('<script>x', DEFAULT_BRAND_COLOR)
    expect(svg).not.toMatch(/<script/i)
  })
  it('falls back to a bullet for an empty name', () => {
    const { svg } = monogramSvg('   ', DEFAULT_BRAND_COLOR)
    expect(svg).toContain('•')
  })
})

describe('normalizeBrandColor — safe hex only', () => {
  it('keeps a valid 6-char hex (uppercased, hashed)', () => {
    expect(normalizeBrandColor('#abcdef')).toBe('#ABCDEF')
    expect(normalizeBrandColor('abcdef')).toBe('#ABCDEF')
  })
  it('keeps a valid 8-char hex', () => {
    expect(normalizeBrandColor('#abcdef80')).toBe('#ABCDEF80')
  })
  it('expands 3-char shorthand', () => {
    expect(normalizeBrandColor('#abc')).toBe('#AABBCC')
  })
  it('falls back to default on junk (no inline-style injection)', () => {
    expect(normalizeBrandColor('red; background:url(x)')).toBe(DEFAULT_BRAND_COLOR)
    expect(normalizeBrandColor('')).toBe(DEFAULT_BRAND_COLOR)
    expect(normalizeBrandColor(null)).toBe(DEFAULT_BRAND_COLOR)
  })
})
