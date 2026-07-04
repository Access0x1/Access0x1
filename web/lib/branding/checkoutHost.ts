/**
 * The host the branded checkout link is served from — the truthful base for the
 * `{host}/c/{slug}` link a merchant hands out (receipts, QR, embed).
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_CHECKOUT_HOST` — set this when checkout is served on a
 *      dedicated domain distinct from the dashboard (e.g. a cloner's own
 *      `pay.example.com`). Host only, no scheme (`pay.example.com`).
 *   2. the app's own `window.location.host` — the real domain this deploy runs
 *      on, so the displayed link always matches where the checkout actually is.
 *
 * NEVER a hardcoded brand domain: the base must reflect the real deploy, or the
 * link printed on receipts/QRs points somewhere that doesn't exist (truth-in-copy).
 * Client-only (reads `window`); returns '' during SSR — callers resolve it in an
 * effect and render a neutral placeholder until then.
 */
export function checkoutHost(): string {
  const configured = (process.env.NEXT_PUBLIC_CHECKOUT_HOST ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (configured) return configured
  if (typeof window !== 'undefined') return window.location.host
  return ''
}

/**
 * The full origin (scheme + host) for building an absolute checkout/embed URL.
 * Honors `NEXT_PUBLIC_CHECKOUT_HOST` (assumed https) when set, else the real
 * `window.location.origin`. '' during SSR.
 */
export function checkoutOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_CHECKOUT_HOST ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (configured) return `https://${configured}`
  if (typeof window !== 'undefined') return window.location.origin
  return ''
}
