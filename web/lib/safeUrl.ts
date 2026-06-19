/**
 * safeUrl.ts — open-redirect / `javascript:`-URI guard for caller-supplied URLs.
 *
 * The checkout page reads `?return_url=` straight from the query string and the
 * funding routes accept a `redirectUrl` from the request body. Both are then
 * rendered into an `<a href>` ("Return to merchant") or forwarded to an external
 * on/off-ramp provider. Dropping a raw, attacker-controlled value into either is
 * the worst-placed redirect surface in the app: it sits on the *payment-confirmed*
 * page, where a `javascript:` URI executes on click and an `https://evil.example`
 * is a clean phishing hand-off after a buyer just paid (red-report C-1 / O-11).
 *
 * `safeReturnUrl` is the single, PURE chokepoint every extraction / render /
 * forward point funnels through. It returns the URL **only** when it parses AND
 * its scheme is exactly `https:` — rejecting `javascript:`, `data:`, `http:`,
 * protocol-relative (`//evil`), and relative paths (which `new URL` can't parse
 * without a base, so they fail closed). On rejection it returns the caller's
 * `fallback` (a known-safe home, or `undefined` so the link/param is simply
 * omitted) — never the tainted value.
 *
 * `https:`-only is deliberately strict: this is an external return link, so a
 * scheme that can't carry a cross-origin phishing/exfil payload over the wire is
 * required. No allowlist is hardcoded here (origins differ per merchant/deploy);
 * a caller that knows its allowed origins can compose this with its own check.
 */

/** Parse + scheme-check a single URL string; `null` when it isn't a clean `https:` URL. */
function parseHttpsUrl(raw: string): URL | null {
  // `new URL` with no base rejects relative + protocol-relative inputs (fail closed).
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  // Scheme is the security gate: only `https:` may be rendered/forwarded.
  // (`new URL` lowercases the protocol, so `JavaScript:` / `HTTPS:` normalize.)
  return parsed.protocol === 'https:' ? parsed : null
}

/**
 * Return `raw` only when it is a parseable, `https:`-scheme URL; otherwise the
 * `fallback` (default `undefined`).
 *
 * Use at EVERY point a caller-supplied URL is extracted from a query string /
 * request body, rendered into an `href`, or forwarded to a provider — never trust
 * a value that skipped this guard.
 *
 * @param raw      The untrusted candidate (query param, body field, prop).
 * @param fallback Known-safe value returned on rejection (e.g. the site home).
 *                 Defaults to `undefined`, which callers treat as "no redirect".
 * @returns The canonical `https:` URL string, or `fallback`.
 */
export function safeReturnUrl(
  raw: unknown,
  fallback: string | undefined = undefined,
): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback
  const parsed = parseHttpsUrl(raw.trim())
  // Return the parser's canonical serialization (normalized), not the raw input.
  return parsed ? parsed.href : fallback
}

/** True when `raw` is a parseable `https:` URL — the boolean form of the guard. */
export function isSafeReturnUrl(raw: unknown): boolean {
  return typeof raw === 'string' && parseHttpsUrl(raw.trim()) !== null
}
