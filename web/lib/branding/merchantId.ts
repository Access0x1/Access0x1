/**
 * merchantId.ts — resolve a tenant's on-chain merchant id for the dashboard.
 *
 * The dashboard needs the merchant id from TWO sources:
 *   - the durable branding row (`branding.merchantId`), written server-side when
 *     the tenant switched on payments (POST /api/branding/attach-onchain), and
 *   - the per-browser `localStorage('ax1_merchant_id')` cache the register step
 *     writes locally.
 *
 * The branding row is preferred because it is durable across browsers/devices —
 * a merchant who switched on payments on their laptop sees their receipts on
 * their phone. localStorage is the local fast-path / offline fallback. This pure
 * resolver is unit-tested directly (the `canShowCasinoBadge` precedent).
 */

/**
 * Resolve the merchant id to use, PREFERRING the durable branding row over the
 * per-browser localStorage cache.
 *
 * @param fromBranding - `branding.merchantId` (string decimal) or null/undefined.
 * @param fromLocalStorage - the `ax1_merchant_id` localStorage value, or null.
 * @returns the chosen merchant-id string, or null when neither is present/usable.
 */
export function resolveMerchantId(
  fromBranding: string | null | undefined,
  fromLocalStorage: string | null | undefined,
): string | null {
  const branding = (fromBranding ?? '').trim()
  if (branding) return branding
  const local = (fromLocalStorage ?? '').trim()
  if (local) return local
  return null
}
