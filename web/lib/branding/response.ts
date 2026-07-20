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
import type { CheckoutMode, HumanVerifier, MerchantVertical, TenantBranding } from './store.js';
import type { TrustTier } from '../verification/tiers.js';

/**
 * The chain a BRANDED slug checkout (`/c/<slug>`) settles on — SERVER-AUTHORITATIVE.
 *
 * A slug binds to exactly ONE merchant on ONE chain: {@link PublicBranding.chainId}
 * is set server-side from the merchant's record, keyed by the immutable slug. The
 * branded checkout MUST take payment on that chain and NEVER on a chain chosen by
 * the URL.
 *
 * Why this is a security boundary, not a convenience: `Access0x1Router.registerMerchant`
 * is permissionless and ids are sequential (`nextMerchantId++`), so an attacker can
 * register the SAME merchant id on another mirror chain with THEIR OWN payout. If the
 * slug checkout honored a `?chainId=` param, `/c/<acme>?chainId=<attacker-chain>` would
 * keep Acme's real, unspoofable branding (name/logo/color are server-keyed by slug)
 * while loading the impostor merchant record — settling the buyer's funds to the
 * attacker. So the slug's settlement chain comes ONLY from the payload.
 *
 * This is the opposite of the `/m/[merchantId]` checkout, where merchantId AND name are
 * already URL-supplied, the on-chain `MerchantIdentity` is the trust anchor, and a
 * per-link `?chainId=` is a legitimate multichain feature (see `resolveCheckoutChainId`).
 */
export function slugSettlementChainId(branding: Pick<PublicBranding, 'chainId'>): number {
  return branding.chainId;
}

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
  /**
   * The merchant's business category (Casino vertical). PUBLIC display/gate data:
   * the checkout uses it to know a casino's World ID gate is load-bearing. It
   * never reveals a payout address.
   */
  vertical: MerchantVertical;
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
 * @returns the public payload, with no payout address included.
 */
export function toPublicBranding(row: TenantBranding): PublicBranding {
  // SERVER-AUTHORITATIVE settlement chain: the chain the merchant actually
  // registered on (persisted at attach-on-chain), NOT the app's build-time
  // default. The mirror shares one router address across chains and ids are
  // per-chain + permissionless, so a global default would let a same-id impostor
  // on the default chain receive the buyer's funds; binding to the real
  // registration chain closes that. A legacy row (no merchantChainId) falls back
  // to the default — unchanged from before this field existed.
  const chainId = row.merchantChainId ?? getDefaultChainId();
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
    vertical: row.vertical,
    verifiedOperator: row.verifiedOperator,
  };
}
