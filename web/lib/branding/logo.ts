/**
 * logo.ts — logo sanitize + raster→inline-SVG conversion (ADR unit 3, "Make it
 * yours" → "Add your logo").
 *
 * The MetaMask Snap's `Image` component accepts INLINE SVG strings only — never
 * an `https://` URL (ADR D5, C2). So every merchant logo must end up as a
 * sanitized inline-SVG string (`logo_svg_inline`):
 *
 *   - An uploaded SVG is SANITIZED: every `<script>`, every `on*` event handler,
 *     every `javascript:`/external-resource reference is stripped before the
 *     string is ever stored or shipped to a wallet. We never trust merchant SVG.
 *   - An uploaded raster (PNG/JPG, supplied as a `data:` URI) is WRAPPED in a
 *     minimal SVG `<image>` element so the Snap can render it — the raster bytes
 *     stay inert, no script can ride along.
 *
 * Pure + synchronous so it unit-tests offline with no DOM and no network. The
 * sanitizer is intentionally a strict ALLOW-almost-nothing scrubber rather than
 * a full HTML parser: we only need a static mark to render inside an `<img>`,
 * and the security bar is "no executable content reaches a wallet" (ADR
 * "Security notes carried forward"). When in doubt we strip.
 */

/** The maximum byte length we will accept/produce for an inline-SVG string. */
export const MAX_LOGO_SVG_BYTES = 256 * 1024; // 256 KB — a logo, not an image bank.

/** The maximum byte length we will accept for a raw raster data-URI. */
export const MAX_LOGO_RASTER_BYTES = 512 * 1024; // 512 KB raw raster before wrapping.

/** Raster MIME types we will wrap into an inline SVG `<image>`. */
const ALLOWED_RASTER_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

/** The outcome of sanitizing/converting a logo. */
export interface LogoResult {
  /** The sanitized inline-SVG string, ready for `logo_svg_inline` + the Snap. */
  svg: string;
  /** How it was produced — useful for the upload route's response + tests. */
  kind: 'svg' | 'raster';
}

/** Thrown when a logo cannot be safely sanitized/converted. */
export class LogoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogoError';
  }
}

/** UTF-8 byte length of a string (no Buffer dependency — works in any runtime). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Strip every executable / fetching construct from an SVG string. This is a
 * deny-by-pattern scrubber, applied repeatedly until the string stops changing
 * so nested/obfuscated re-introductions cannot survive one pass.
 *
 * Removes:
 *   - `<script>…</script>` blocks (and bare/self-closing `<script .../>`),
 *   - `<foreignObject>…</foreignObject>` (an HTML-injection vector inside SVG),
 *   - every `on*="…"` / `on*='…'` event-handler attribute,
 *   - `javascript:` URIs anywhere,
 *   - `<!ENTITY …>` / DOCTYPE (XXE / entity-expansion vector),
 *   - `<use href="http(s)://…">` and any `href`/`xlink:href` pointing off-document
 *     (remote refs); inline `data:image/*` refs are kept (that is how we wrap raster).
 *
 * @param svg - the raw SVG string.
 * @returns the scrubbed SVG string (still must pass {@link assertIsSvg}).
 */
export function sanitizeSvg(svg: string): string {
  let out = svg;
  let prev: string;
  do {
    prev = out;
    out = out
      // <script> in any form
      .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<script\b[^>]*\/?>/gi, '')
      // <foreignObject> can smuggle live HTML
      .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
      .replace(/<foreignObject\b[^>]*\/?>/gi, '')
      // <!DOCTYPE …> and <!ENTITY …> (XXE / billion-laughs)
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .replace(/<!ENTITY[\s\S]*?>/gi, '')
      // on*="…" / on*='…' / on*=bare event handlers
      .replace(/\son[a-z0-9_-]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z0-9_-]+\s*=\s*'[^']*'/gi, '')
      .replace(/\son[a-z0-9_-]+\s*=\s*[^\s>]+/gi, '')
      // javascript: URIs anywhere (attribute or text)
      .replace(/javascript:/gi, '')
      // remote href / xlink:href (keep data: refs; drop http(s)/// network refs)
      .replace(/\s(?:xlink:)?href\s*=\s*"(?!data:)[^"]*"/gi, '')
      .replace(/\s(?:xlink:)?href\s*=\s*'(?!data:)[^']*'/gi, '');
  } while (out !== prev);
  return out.trim();
}

/** A loose structural check that the scrubbed string is still a single SVG root. */
function assertIsSvg(svg: string): void {
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg\s*>\s*$/i.test(svg)) {
    throw new LogoError('Logo SVG must be a single <svg>…</svg> element.');
  }
  // Belt-and-suspenders: nothing executable may survive the scrub.
  if (/<script\b/i.test(svg) || /\son[a-z0-9_-]+\s*=/i.test(svg) || /javascript:/i.test(svg)) {
    throw new LogoError('Logo SVG still contained executable content after sanitization.');
  }
}

/**
 * Sanitize a merchant-supplied SVG into a safe inline-SVG string.
 *
 * @param svg - the raw SVG markup.
 * @returns the sanitized SVG + kind `'svg'`.
 * @throws {LogoError} if it is too large, empty, or not a valid <svg> after scrub.
 */
export function sanitizeSvgLogo(svg: string): LogoResult {
  const trimmed = (svg ?? '').trim();
  if (trimmed.length === 0) throw new LogoError('Logo SVG is empty.');
  if (byteLength(trimmed) > MAX_LOGO_SVG_BYTES) {
    throw new LogoError(`Logo SVG exceeds ${MAX_LOGO_SVG_BYTES} bytes.`);
  }
  const cleaned = sanitizeSvg(trimmed);
  assertIsSvg(cleaned);
  if (byteLength(cleaned) > MAX_LOGO_SVG_BYTES) {
    throw new LogoError(`Logo SVG exceeds ${MAX_LOGO_SVG_BYTES} bytes after sanitization.`);
  }
  return { svg: cleaned, kind: 'svg' };
}

/**
 * Wrap a raster image data-URI (`data:image/png;base64,…`) into a minimal inline
 * SVG `<image>` so the Snap's `Image` component can render it. The raster bytes
 * are inert (no script can ride a base64 image); we set a square viewBox so the
 * mark scales cleanly at any wallet size.
 *
 * @param dataUri - a `data:image/<png|jpeg|webp|gif>;base64,…` string.
 * @returns the wrapping SVG + kind `'raster'`.
 * @throws {LogoError} on an unsupported MIME, malformed data-URI, or oversize input.
 */
export function rasterDataUriToSvg(dataUri: string): LogoResult {
  const trimmed = (dataUri ?? '').trim();
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(trimmed);
  if (!m) {
    throw new LogoError('Logo must be a base64 data: URI (data:image/<type>;base64,…).');
  }
  const mime = m[1].toLowerCase();
  if (!ALLOWED_RASTER_MIME.has(mime)) {
    throw new LogoError(`Unsupported image type "${mime}". Use PNG, JPG, WEBP, or GIF.`);
  }
  if (byteLength(trimmed) > MAX_LOGO_RASTER_BYTES) {
    throw new LogoError(`Logo image exceeds ${MAX_LOGO_RASTER_BYTES} bytes.`);
  }
  // A square 256×256 canvas; the raster is the only child, fully inert.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' +
    `<image width="256" height="256" href="${trimmed}"/>` +
    '</svg>';
  // Sanitize the wrapper too — the data: href is explicitly preserved by the
  // sanitizer's `(?!data:)` guard, so this only proves the wrapper is clean.
  const cleaned = sanitizeSvg(svg);
  assertIsSvg(cleaned);
  return { svg: cleaned, kind: 'raster' };
}

/**
 * Single entry point used by the upload route: take whatever the merchant gave
 * us (an SVG string OR a raster data-URI) and return a safe inline-SVG string.
 *
 * @param input - raw SVG markup, or a `data:image/*;base64,…` raster URI.
 * @returns a {@link LogoResult} with the sanitized inline SVG.
 * @throws {LogoError} on anything unsafe or unsupported.
 */
export function toInlineSvgLogo(input: string): LogoResult {
  const trimmed = (input ?? '').trim();
  if (trimmed.length === 0) throw new LogoError('No logo provided.');
  if (/^data:/i.test(trimmed)) return rasterDataUriToSvg(trimmed);
  if (/^<svg[\s>]/i.test(trimmed) || /<svg[\s>]/i.test(trimmed)) return sanitizeSvgLogo(trimmed);
  throw new LogoError('Logo must be an SVG or a base64 image data: URI.');
}

/**
 * Build an auto-monogram inline SVG from a display name on a brand color — the
 * skip-logo default so the checkout/wallet surface never looks broken (ADR D2
 * step 3 escape hatch, D6 sensible defaults). Takes the first letters of up to
 * two words.
 *
 * @param name - the business display name.
 * @param brandColor - a validated 6/8-char hex (see {@link normalizeBrandColor}).
 * @returns a self-contained inline SVG monogram (kind `'svg'`).
 */
export function monogramSvg(name: string, brandColor: string): LogoResult {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const text = (initials || '•').replace(/[<>&"']/g, ''); // never inject markup
  const bg = normalizeBrandColor(brandColor);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' +
    `<rect width="256" height="256" rx="48" fill="${bg}"/>` +
    `<text x="128" y="128" dy="0.36em" text-anchor="middle" ` +
    `font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" ` +
    `font-size="120" font-weight="700" fill="#ffffff">${text}</text>` +
    '</svg>';
  // Pass it through the scrubber so the monogram path obeys the same contract.
  return sanitizeSvgLogo(svg);
}

/** The Access0x1 default brand color (matches Tailwind `rail` / embed default). */
export const DEFAULT_BRAND_COLOR = '#6366F1';

/**
 * Re-validate a brand color to a safe 6- or 8-char hex (CR law / ADR D3). Any
 * malformed input falls back to {@link DEFAULT_BRAND_COLOR} — a brand color can
 * never become an inline-style injection vector.
 *
 * @param input - the candidate color (with or without leading `#`).
 * @returns a normalized `#RRGGBB` / `#RRGGBBAA` string.
 */
export function normalizeBrandColor(input: string | null | undefined): string {
  if (typeof input !== 'string') return DEFAULT_BRAND_COLOR;
  const hex = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{8}$/.test(hex)) {
    return `#${hex.toUpperCase()}`;
  }
  // Allow 3-char shorthand, expand it; otherwise default.
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split('').map((c) => c + c).join('').toUpperCase()}`;
  }
  return DEFAULT_BRAND_COLOR;
}
