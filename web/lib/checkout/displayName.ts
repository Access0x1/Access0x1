/**
 * @file displayName.ts — resolve the checkout header name from UNTRUSTED sources.
 *
 * The `/m/{merchantId}` checkout takes its display name from the URL `?name=`
 * param and a `localStorage` fallback — both fully attacker-/user-controllable,
 * unauthenticated, and unbounded. That name renders as the checkout `<h1>` on a
 * REAL merchant's page, so a crafted link
 * (`/m/42?name=Acme%20Support%20—%20call%201-800-…`) would paint the attacker's
 * words onto merchant #42's genuine, pay-enabled storefront (a spoofing/phishing
 * surface — not XSS, since React escapes the text, but a visible-word injection).
 *
 * This resolver is the single choke point: it runs both untrusted sources
 * through {@link sanitizeDisplayName} (tag/bracket strip, whitespace collapse,
 * 80-char clamp — the SAME sanitizer the server branding store applies to a
 * merchant's own stored name) and falls back to the neutral `Merchant #<id>`
 * label when neither yields anything. It is PURE (no DOM, no network), so the
 * decision is unit-tested directly rather than through the client component.
 *
 * The unspoofable identity signal still sits below the header:
 * `<MerchantIdentity>` renders the ENSIP-19 verified payout name (or the
 * truncated address), which an attacker cannot forge — sanitizing the header
 * name removes the unbounded/markup vector; the verified identity is what a
 * buyer trusts.
 */

import { sanitizeDisplayName } from '../branding/store'

/**
 * Resolve the checkout header display name from the untrusted param + stored
 * fallback, else the neutral merchant-id label.
 *
 * @param nameParam - the raw `?name=` URL param (untrusted), or null/undefined.
 * @param storedName - the raw `localStorage` fallback (untrusted), or null.
 * @param merchantIdLabel - the neutral label to fall back to (e.g. the merchant
 *   id string); used verbatim only when both untrusted sources sanitize empty.
 * @returns a sanitized, ≤80-char plain-text name safe to render as text.
 */
export function resolveCheckoutDisplayName(
  nameParam: string | null | undefined,
  storedName: string | null | undefined,
  merchantIdLabel: string,
): string {
  const fromParam = sanitizeDisplayName(nameParam ?? '')
  if (fromParam.length > 0) return fromParam
  const fromStore = sanitizeDisplayName(storedName ?? '')
  if (fromStore.length > 0) return fromStore
  return `Merchant #${merchantIdLabel}`
}
