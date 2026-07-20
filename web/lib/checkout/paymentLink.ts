/**
 * @file paymentLink.ts — build the shareable `/m/{merchantId}` checkout link.
 *
 * `CheckoutView` prices a visit from its `?amount=` URL param, falling back to
 * a generic $29.00 when the param is absent (so a bare `/m/{id}` link still
 * renders *something*). `LinkCard` hands a freshly-registered merchant their
 * "Payment link" / QR right after `RegisterForm` collects their real price —
 * that artifact must carry `?amount=` or every buyer who scans it gets
 * charged the generic fallback instead of the price the merchant just set.
 *
 * Pure (no DOM), so the link format is unit-tested directly rather than
 * through the component's `window.location.origin` effect — the same split
 * `resolveCheckoutDisplayName` uses for the checkout header name.
 */

/**
 * Build the merchant's shareable checkout link, carrying their own USD price.
 *
 * @param origin - the deploy origin (`window.location.origin`); empty until
 *   the client-side effect resolves it, in which case this returns ''.
 * @param merchantId - the on-chain merchant id from `registerMerchant`.
 * @param priceUsd - the merchant's price, already formatted (e.g. "29.00").
 * @returns the full checkout URL with `?amount=` set, or '' while origin is unknown.
 */
export function buildMerchantPaymentLink(
  origin: string,
  merchantId: bigint,
  priceUsd: string,
): string {
  if (!origin) return ''
  return `${origin}/m/${merchantId.toString()}?amount=${priceUsd}`
}
