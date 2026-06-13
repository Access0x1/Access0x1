import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BRAND_COLOR,
  MAX_LOGO_SVG_LEN,
  sanitizeBrandColor,
  sanitizeLogoSvg,
  sanitizeText,
} from '../src/branding/sanitize';

describe('sanitizeText', () => {
  it('trims, collapses whitespace, and caps length', () => {
    expect(sanitizeText("  Joe's   Barbershop  ", 60)).toBe("Joe's Barbershop");
    expect(sanitizeText('abcdef', 3)).toBe('abc');
  });

  it('strips control characters', () => {
    // "Joe" + NUL + BEL + "Cuts" should collapse to "Joe Cuts".
    const withControls = `Joe${String.fromCharCode(0)}${String.fromCharCode(
      7,
    )}Cuts`;
    expect(sanitizeText(withControls, 60)).toBe('Joe Cuts');
  });

  it('returns empty string for non-strings', () => {
    expect(sanitizeText(undefined, 60)).toBe('');
    expect(sanitizeText(42, 60)).toBe('');
    expect(sanitizeText(null, 60)).toBe('');
  });
});

describe('sanitizeBrandColor', () => {
  it('accepts #rgb, #rrggbb, and #rrggbbaa', () => {
    expect(sanitizeBrandColor('#abc')).toBe('#abc');
    expect(sanitizeBrandColor('#A1B2C3')).toBe('#A1B2C3');
    expect(sanitizeBrandColor('#11223344')).toBe('#11223344');
  });

  it('falls back to the default for unsafe / non-hex values', () => {
    expect(sanitizeBrandColor('red')).toBe(DEFAULT_BRAND_COLOR);
    expect(sanitizeBrandColor('rgb(255,0,0)')).toBe(DEFAULT_BRAND_COLOR);
    expect(sanitizeBrandColor('#zzzzzz')).toBe(DEFAULT_BRAND_COLOR);
    expect(sanitizeBrandColor('')).toBe(DEFAULT_BRAND_COLOR);
    expect(sanitizeBrandColor(undefined)).toBe(DEFAULT_BRAND_COLOR);
  });
});

describe('sanitizeLogoSvg', () => {
  const GOOD =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

  it('accepts a clean inline SVG document', () => {
    expect(sanitizeLogoSvg(GOOD)).toBe(GOOD);
  });

  it('accepts an SVG wrapping a data-URI <image> (raster conversion form)', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>';
    expect(sanitizeLogoSvg(svg)).toBe(svg);
  });

  it('rejects a non-SVG string / bare URL', () => {
    expect(sanitizeLogoSvg('https://evil.example/logo.png')).toBeNull();
    expect(sanitizeLogoSvg('<div>not an svg</div>')).toBeNull();
    expect(sanitizeLogoSvg('')).toBeNull();
  });

  it('rejects SVG carrying a <script>', () => {
    expect(sanitizeLogoSvg('<svg><script>alert(1)</script></svg>')).toBeNull();
  });

  it('rejects SVG with an inline event handler', () => {
    expect(sanitizeLogoSvg('<svg onload="steal()"><rect/></svg>')).toBeNull();
  });

  it('rejects SVG with a foreignObject, iframe, use, or entity/doctype', () => {
    expect(
      sanitizeLogoSvg('<svg><foreignObject><body/></foreignObject></svg>'),
    ).toBeNull();
    expect(sanitizeLogoSvg('<svg><iframe src="x"/></svg>')).toBeNull();
    expect(sanitizeLogoSvg('<svg><use href="#x"/></svg>')).toBeNull();
    expect(sanitizeLogoSvg('<!DOCTYPE svg><svg><rect/></svg>')).toBeNull();
    expect(
      sanitizeLogoSvg('<svg><!ENTITY xxe SYSTEM "file:///etc/passwd"></svg>'),
    ).toBeNull();
  });

  it('rejects a javascript: URL embedded in the SVG', () => {
    expect(
      sanitizeLogoSvg('<svg><a href="javascript:alert(1)"/></svg>'),
    ).toBeNull();
  });

  it('rejects an over-large SVG (state-size guard)', () => {
    const huge = `<svg>${'a'.repeat(MAX_LOGO_SVG_LEN)}</svg>`;
    expect(sanitizeLogoSvg(huge)).toBeNull();
  });

  it('returns null for non-strings', () => {
    expect(sanitizeLogoSvg(undefined)).toBeNull();
    expect(sanitizeLogoSvg(123)).toBeNull();
  });
});
