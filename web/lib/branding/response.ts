/**
 * response.ts — the PUBLIC branding payload shape + CORS headers shared by the
 * read endpoints (ADR unit 4, D4 b/c).
 *
 * `GET /api/branding/{slug}` and `GET /api/branding/by-merchant/{id}` BOTH return
 * exactly this shape, read-only, cacheable, CORS-open so the one-tag embed
 * (cross-origin `fetch`) and the Snap's `fetch` (which carries `Origin: null`)
 * can both read it.
 *
 * SECURITY (ADR "Security notes carried forward"): this payload NEVER includes a
 * payout address, fee config, owner, or any write capability. Only display data
 * + the public router/chain the embed already needs to build the pay calldata.
 */

import { getDefaultChainId, getRouterAddress } from '../chains.js';
import type { CheckoutMode, HumanVerifier, TenantBranding } from './store.js';
import type { TrustTier } from '../verification/tiers.js';

/** The exact public branding payload (ADR D4): no payout address, ever. */
export interface PublicBranding {
  /** The readable business name the customer sees. */
  name: string;
  /** The one-line description (plain text). */
  description: string;
  /** The logo as an inline SVG string (what the Snap's `Image` needs). */
  logoSvg: string;
  /** The validated 6/8-char hex brand color. */
  brandColor: string;
  /** On-chain merchant id as a string, or null if not registered yet. */
  merchantId: string | null;
  /** The Access0x1Router address for the default chain (public; embed needs it). */
  router: string | null;
  /** The default chain id. */
  chainId: number;
  /**
   * Whether the readable name is committed on-chain (`nameHash` present). The
   * "verified on-chain" badge is shown ONLY by the surface that itself confirms
   * keccak256(name) === merchants(id).nameHash — we never assert it here, we
   * just report that an on-chain registration exists (ADR honesty law #4).
   */
  onChain: boolean;
  /**
   * The merchant's D0 checkout choice (World ID ADR D0). PUBLIC display/gate
   * data only — it tells the checkout whether to mount the World ID gate or run
   * the Unlink leg. It is NOT a secret and never reveals a payout address.
   */
  checkoutMode: CheckoutMode;
  /** Where a verified-human proof is checked (only meaningful for verified-human). */
  humanVerifier: HumanVerifier;
  /**
   * The minimum Super Verification trust tier a buyer must hold to pay this
   * merchant ('standard' = anyone). PUBLIC gate data — the checkout uses it to
   * gate the pay button; it reveals no payout address.
   */
  requiredTier: TrustTier;
  /** Whether the business is operated by a verified real human (ADR D1.4 badge). */
  verifiedOperator: boolean;
}

/** CORS headers for the public read endpoints (embed + Snap `fetch`). */
export const PUBLIC_BRANDING_CORS: Readonly<Record<string, string>> = {
  // Open read: the embed is cross-origin and the Snap fetch carries Origin: null.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  // Cacheable: branding changes rarely; let the CDN/browser cache it briefly.
  'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
};

/**
 * Shape a stored {@link TenantBranding} row into the public payload. Resolves
 * the router address from env for the default chain (or null when unconfigured
 * — never throws, the embed degrades gracefully to USD-only).
 *
 * @param row - the stored branding row.
 * @returns the public, payout-free payload.
 */
export function toPublicBranding(row: TenantBranding): PublicBranding {
  const chainId = getDefaultChainId();
  let router: string | null = null;
  try {
    router = getRouterAddress(chainId);
  } catch {
    router = null; // env not set — embed falls back to USD-only (law #4).
  }
  return {
    name: row.displayName,
    description: row.description,
    logoSvg: row.logoSvgInline,
    brandColor: row.brandColor,
    merchantId: row.merchantId,
    router,
    chainId,
    onChain: row.merchantId !== null && row.nameHash !== undefined,
    checkoutMode: row.checkoutMode,
    humanVerifier: row.humanVerifier,
    requiredTier: row.requiredTier,
    verifiedOperator: row.verifiedOperator,
  };
}
