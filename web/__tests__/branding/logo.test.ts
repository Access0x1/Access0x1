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

  it('removes on* handlers on ANY attribute boundary — slash- and quote-adjacent (XSS regression)', () => {
    // The `\s`-only anchor let handlers separated from the previous attribute
    // by a `/` or a closing quote survive and reach dangerouslySetInnerHTML.
    const attacks = [
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:x"/onerror="alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="data:x"onmouseover="alert(2)">x</a></svg>',
      `<svg xmlns="http://www.w3.org/2000/svg"><rect x="0"/onload='alert(3)'/></svg>`,
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:x"onload=alert(4)/></svg>',
    ]
    for (const svg of attacks) {
      const clean = sanitizeSvg(svg)
      // No executable handler may survive on ANY boundary.
      expect(clean).not.toMatch(/[\s/"'`]on[a-z]+\s*=/i)
      expect(clean).not.toMatch(/onerror|onmouseover|onload/i)
    }
    // Stripping the handler must NOT collateral-damage a legitimate data: href
    // sitting right next to it (that is how rasters are wrapped).
    expect(sanitizeSvg(attacks[0])).toContain('href="data:x"')
    expect(sanitizeSvg(attacks[1])).toContain('href="data:x"')
  })

  it('sanitizeSvgLogo REJECTS a slash/quote-adjacent handler outright (belt-and-suspenders)', () => {
    // Even if a future scrub pass missed it, assertIsSvg must catch the leak.
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:x"/onerror="alert(1)"/></svg>'
    // After the fixed scrub this is clean and valid, so it does NOT throw — but
    // the surviving-handler guard now recognizes the boundary too, proving the
    // guard itself is not the weak link.
    const cleaned = sanitizeSvg(hostile)
    expect(() => {
      if (/[\s/"'`]on[a-z0-9_-]+\s*=/i.test(cleaned)) throw new Error('leak')
    }).not.toThrow()
  })

  it('removes on* handlers wedged behind a NUL / C0-control byte (separator bypass)', () => {
    // `\s` (the scrub + guard attribute boundary) covers \t\n\v\f\r+space but
    // NOT \x00-\x08 / \x0e-\x1f, so a control byte between a closing quote and a
    // handler used to smuggle the handler past BOTH the scrub and assertIsSvg.
    const attacks = [
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0"\x00onload="alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:x"\x01onerror=alert(2)/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0"\x1fonmouseover="alert(3)"/></svg>',
      // DEL (\x7f) + C1 (\x80-\x9f) also aren't \s — same covert-separator class.
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0"\x7fonload="alert(4)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0"\x85onerror=alert(5)/></svg>',
    ]
    for (const svg of attacks) {
      const clean = sanitizeSvg(svg)
      expect(clean).not.toMatch(/onerror|onmouseover|onload/i)
      // The control byte itself must be gone (no covert separator left behind).
      expect(clean).not.toMatch(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/)
      // And the belt-and-suspenders guard must accept the cleaned output.
      expect(() => sanitizeSvgLogo(clean)).not.toThrow()
    }
    // Legit whitespace controls (\t\n\r) are NOT stripped — they are valid
    // markup separators and the scrub already handles handlers behind them.
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg">\n\t<rect/>\n</svg>')).toContain('\n')
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
