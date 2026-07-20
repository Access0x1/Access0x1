/**
 * Branding sanitization — the mandatory security seam (ADR D5 / Consequences).
 *
 * Every merchant-supplied branding value (name, description, brand color, and
 * crucially the inline-SVG logo) is untrusted: it arrives over `wallet_invokeSnap`
 * from a hosted page/embed, or over `fetch()` from the public `/api/branding`
 * endpoint. Before any of it is stored in `snap_manageState` or rendered into the
 * in-wallet UI, it passes through here.
 *
 * The `Image` component renders an SVG inside an `<img>`, which already strips
 * scripts/interactivity — but ADR doctrine is "sanitize at the source too". So we
 * reject any SVG carrying `<script>`, event handlers, `javascript:`/`data:text/html`
 * URLs, `<foreignObject>`, or external references, rather than trusting the
 * downstream `<img>` sandbox alone.
 *
 * NOTHING here gates a money path. Branding is display-only (doctrine #1): an
 * invalid logo just falls back to no-logo; it never blocks a payment or a refund.
 */

/** Max characters for a merchant display name (matches the hosted onboarding cap). */
export const MAX_NAME_LEN = 60;
/** Max characters for the one-line description (ADR D2: ~140 chars). */
export const MAX_DESCRIPTION_LEN = 140;
/** Max byte length of an inline-SVG logo string we will accept (guards state size). */
export const MAX_LOGO_SVG_LEN = 32_768;
/** The default brand color when none is supplied or the supplied one is unsafe. */
export const DEFAULT_BRAND_COLOR = '#4f46e5';

/**
 * Patterns that make an SVG string unsafe to store or render. Case-insensitive.
 * Conservative by design — a logo that trips any of these is rejected outright.
 */
const UNSAFE_SVG_PATTERNS: RegExp[] = [
  /<\s*script/iu,
  /<\s*foreignObject/iu,
  /<\s*iframe/iu,
  /<\s*use\b/iu, // external/local <use xlink:href> references
  /\son\w+\s*=/iu, // inline event handlers: onload=, onclick=, ...
  /javascript\s*:/iu,
  /data\s*:\s*text\/html/iu,
  /<!ENTITY/iu, // XML entity-expansion / XXE vectors
  /<!DOCTYPE/iu,
];

/**
 * Collapse whitespace and trim an unstructured text string, then hard-cap its length.
 * Control characters are stripped so nothing odd reaches the wallet UI.
 *
 * @param value - The untrusted string (or any value).
 * @param maxLen - The maximum length to keep.
 * @returns A clean, length-capped string (empty string if not a usable string).
 */
export function sanitizeText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  // Strip control characters (codepoints < 0x20 and DEL 0x7f), then collapse
  // runs of whitespace to a single space. Built without embedding literal
  // control bytes in source: the range is expressed via \u escapes.
  // eslint-disable-next-line no-control-regex
  const controlChars = /[\u0000-\u001f\u007f]/gu;
  const cleaned = value
    .replace(controlChars, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.slice(0, maxLen);
}

/**
 * Validate a hex brand color (`#rgb`, `#rrggbb`, or `#rrggbbaa`). Anything else
 * — including a `rgb()` string that could smuggle CSS — falls back to the default.
 *
 * @param value - The untrusted color value.
 * @returns A safe `#`-prefixed hex string, or {@link DEFAULT_BRAND_COLOR}.
 */
export function sanitizeBrandColor(value: unknown): string {
  if (
    typeof value === 'string' &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value.trim())
  ) {
    return value.trim();
  }
  return DEFAULT_BRAND_COLOR;
}

/**
 * Validate an inline-SVG logo string. Returns the SVG unchanged if it is a
 * plausible `<svg>…</svg>` document with no `<script>` tag, within the size cap; otherwise
 * returns `null` so the caller renders the no-logo fallback.
 *
 * NOTE: ADR D5 — `Image` accepts inline SVG strings ONLY (never `https://` URLs).
 * Raster logos are converted upstream (on upload) into an SVG `<image>` data-URI,
 * so a valid logo here is always already an `<svg>` wrapper.
 *
 * @param value - The untrusted logo string.
 * @returns The sanitized inline-SVG string, or `null` if unusable/unsafe.
 */
export function sanitizeLogoSvg(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const svg = value.trim();
  if (svg.length === 0 || svg.length > MAX_LOGO_SVG_LEN) {
    return null;
  }
  // Must be an actual SVG document, not arbitrary markup or a bare URL.
  if (!/^<svg[\s>]/iu.test(svg) || !/<\/svg\s*>\s*$/iu.test(svg)) {
    return null;
  }
  for (const pattern of UNSAFE_SVG_PATTERNS) {
    if (pattern.test(svg)) {
      return null;
    }
  }
  return svg;
}
