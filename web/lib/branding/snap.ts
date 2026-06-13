/**
 * snap.ts — the SEAM where the MetaMask Snap-invoke and the World-ID toggle
 * attach later (ADR D4 path 1 / D5). This file deliberately builds NOTHING that
 * touches the wallet; it only defines the typed shape both sides agree on and a
 * single hook point, so the checkout page / embed can call `pushMerchantBranding`
 * the moment the Snap method exists — without any further wiring change here.
 *
 * DO NOT add `wallet_invokeSnap` here in this unit. The Snap `setMerchantBranding`
 * RPC + the branded pre-sign dialog are ADR build-plan units 6/7 (the snap/
 * package), and the World-ID gating is a separate toggle. This module is the
 * stable contract between them and the web app.
 */

import type { PublicBranding } from './response.js'

/** The params the Snap's `setMerchantBranding` RPC will receive (ADR D4 path 1). */
export interface SetMerchantBrandingParams {
  /** On-chain merchant id (the Snap keys its state cache by this). */
  merchantId: string
  /** Readable business name — "Pay {name}" in the wallet. */
  name: string
  /** One-line description (plain text). */
  description: string
  /** Inline SVG logo string (the Snap's Image requires inline SVG, never a URL). */
  logoSvg: string
  /** Validated 6/8-char hex brand color. */
  brandColor: string
}

/**
 * Map a resolved {@link PublicBranding} into the Snap-invoke params. Pure; the
 * caller (checkout page / embed) decides WHEN to push (before sending the pay
 * tx). Returns null when the tenant has no on-chain merchant id yet — there is
 * nothing for the Snap to key on, so we don't push (it falls back to the
 * on-chain nameHash / "Merchant #id" path inside the Snap).
 *
 * @param b - the public branding payload.
 * @returns the Snap params, or null when not on-chain yet.
 */
export function toSnapBrandingParams(b: PublicBranding): SetMerchantBrandingParams | null {
  if (!b.merchantId) return null
  return {
    merchantId: b.merchantId,
    name: b.name,
    description: b.description,
    logoSvg: b.logoSvg,
    brandColor: b.brandColor,
  }
}

/**
 * The single hook the checkout page / embed will call right before sending the
 * pay tx to push branding into the wallet (ADR D4 path 1). It is a NO-OP today:
 * the Snap method (`setMerchantBranding`) is built in a later unit. When that
 * lands, this function gains the `wallet_invokeSnap` call — and every caller
 * already invokes it, so no caller changes.
 *
 * It is intentionally fail-soft: branding is display-only and must NEVER gate or
 * delay the money path (ADR D5). A rejected/absent Snap simply means the wallet
 * shows its default insight; the pay tx proceeds regardless.
 *
 * @param params - the branding to push, or null to skip.
 * @returns a promise that always resolves (never rejects into the pay path).
 */
export async function pushMerchantBranding(
  params: SetMerchantBrandingParams | null,
): Promise<void> {
  if (!params) return
  // SEAM (ADR unit 6): wallet_invokeSnap({ snapId, request: {
  //   method: 'setMerchantBranding', params } }). Not wired in this unit.
  // World-ID toggle (separate): an optional gate may wrap this push later.
  return
}
