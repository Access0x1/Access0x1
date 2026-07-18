/**
 * seed.ts — optional, env-driven FEATURED MERCHANT seed (one stable default brand).
 *
 * The branding store (`store.ts`) is a process-lifetime in-memory map: it starts
 * EMPTY on every boot and forgets everything on restart. That is fine for the
 * onboarding demo (a business signs in and fills the form), but a HOSTED instance
 * often wants to showcase ONE real integrator as its default brand — a row that
 * is already present the moment the process comes up and that survives restarts.
 *
 * This module provides exactly that, generically and config-only: if (and only
 * if) `FEATURED_MERCHANT_SLUG` and `FEATURED_MERCHANT_NAME` are BOTH set in the
 * environment, it upserts ONE {@link TenantBranding} row from those env values.
 * NO company name lives in the repo — the deployment supplies the values. When
 * the env is unset the function does nothing, so the open-source default is the
 * unchanged empty store + the onboarding entry point.
 *
 * Design choices:
 *   - DEPENDENCY-INJECTED upsert: `store.ts` imports this module and calls
 *     `seedFeaturedMerchant(upsertBranding)` at the BOTTOM of its own module,
 *     passing its own writer in. That keeps `seed.ts` free of a back-import of
 *     `store.ts`, so there is no circular module-init hazard.
 *   - IDEMPOTENT: keyed by a stable derived `tenantId` (`featured:<slug>`), so
 *     calling it repeatedly (or after a hot-reload) re-writes the same row rather
 *     than duplicating it. `upsertBranding` is itself idempotent per tenant.
 *   - FAIL-SOFT: any error is swallowed (the seed is a nicety, never load-bearing)
 *     so a bad env value can never crash the store module at import time.
 */

import { monogramSvg, normalizeBrandColor, DEFAULT_BRAND_COLOR } from './logo.js';
import type { BrandingInput, TenantBranding } from './store.js';
import { asCheckoutMode } from './store.js';
import { isSettlementChain } from '../chains.js';

/**
 * The minimal env shape the seed reads — a plain string map. Wider than (and
 * satisfied by) `process.env`, so tests can pass a literal `{}` without
 * supplying `NODE_ENV` and friends.
 */
export type EnvLike = Record<string, string | undefined>;

/** The env var that turns the featured-merchant seed ON (its checkout slug). */
export const FEATURED_SLUG_ENV = 'FEATURED_MERCHANT_SLUG';
/** The env var carrying the business display name (required alongside the slug). */
export const FEATURED_NAME_ENV = 'FEATURED_MERCHANT_NAME';
/** Optional one-line description env var. */
export const FEATURED_DESCRIPTION_ENV = 'FEATURED_MERCHANT_DESCRIPTION';
/** Optional brand-color env var (hex; falls back to the Access0x1 default). */
export const FEATURED_BRAND_COLOR_ENV = 'FEATURED_MERCHANT_BRAND_COLOR';
/**
 * Optional on-chain merchant id env var (positive integer string). When set and
 * valid, the seeded row carries `merchantId` so the checkout Pay card renders
 * immediately without a separate on-chain registration step. Ignored when
 * absent or not a positive integer.
 */
export const FEATURED_MERCHANT_ID_ENV = 'FEATURED_MERCHANT_MERCHANT_ID';
/**
 * Optional chain id the featured merchant registered `merchantId` on. When set to
 * a valid settlement chain, the seeded row carries it as `merchantChainId` so the
 * branded slug settles on the merchant's REAL chain — NOT the app's build-time
 * default. Without this, a featured merchant registered off the default chain
 * would resolve a same-id merchant on the default chain (the wave-4 slug-redirect
 * class); parity with the interactive attach-on-chain path. Ignored when absent or
 * not a settlement chain (⇒ merchantChainId null ⇒ default fallback).
 */
export const FEATURED_MERCHANT_CHAIN_ID_ENV = 'FEATURED_MERCHANT_CHAIN_ID';
/**
 * Optional checkout-mode env var (one of 'standard' | 'verified-human' |
 * 'private'). Defaults to 'standard' when unset or unrecognised — which is
 * always a safe, non-breaking fallback.
 */
export const FEATURED_CHECKOUT_MODE_ENV = 'FEATURED_MERCHANT_CHECKOUT_MODE';

/** The stable tenant id we derive for the seeded featured merchant. */
export function featuredTenantId(slug: string): string {
  return `featured:${slug.trim().toLowerCase()}`;
}

/**
 * Read the featured-merchant env into a {@link BrandingInput}, or return null
 * when the seed is not enabled (slug and/or name missing/blank).
 *
 * Pure + side-effect-free so it unit-tests offline. The logo is the existing
 * auto-monogram derived from the name (no file needed). The merchant payout
 * (`SELLER_ADDRESS`) is NOT part of branding (the public payload never carries a
 * payout address); it is consumed by the x402 seller path on its own.
 *
 * @param env - the environment map to read (defaults to `process.env`).
 * @returns the branding input for the featured merchant, or null when disabled.
 */
export function readFeaturedMerchantInput(
  env: EnvLike = process.env,
): BrandingInput | null {
  const slug = (env[FEATURED_SLUG_ENV] ?? '').trim();
  const name = (env[FEATURED_NAME_ENV] ?? '').trim();
  if (!slug || !name) return null;

  const brandColor = normalizeBrandColor(env[FEATURED_BRAND_COLOR_ENV] ?? DEFAULT_BRAND_COLOR);
  const description = (env[FEATURED_DESCRIPTION_ENV] ?? '').trim();

  // Parse FEATURED_MERCHANT_MERCHANT_ID: accept only positive integers.
  const rawMerchantId = (env[FEATURED_MERCHANT_ID_ENV] ?? '').trim();
  const parsedMerchantId = rawMerchantId ? parseInt(rawMerchantId, 10) : NaN;
  const merchantId: string | null =
    Number.isInteger(parsedMerchantId) && parsedMerchantId > 0
      ? String(parsedMerchantId)
      : null;

  // Parse FEATURED_MERCHANT_CHAIN_ID: the chain the featured merchant registered
  // on. Kept ONLY when it is a real settlement chain (else null ⇒ default fallback),
  // so the seed can never pin the slug to a bad/unroutable chain. This is what lets
  // a featured merchant on a NON-default chain settle correctly (wave-4 parity).
  const rawChainId = (env[FEATURED_MERCHANT_CHAIN_ID_ENV] ?? '').trim();
  const parsedChainId = rawChainId ? Number(rawChainId) : NaN;
  const merchantChainId: number | null = isSettlementChain(parsedChainId) ? parsedChainId : null;

  // Parse FEATURED_MERCHANT_CHECKOUT_MODE; asCheckoutMode defaults to 'standard'.
  const checkoutMode = asCheckoutMode(env[FEATURED_CHECKOUT_MODE_ENV]);

  return {
    tenantId: featuredTenantId(slug),
    displayName: name,
    description: description || undefined,
    checkoutSlug: slug,
    brandColor,
    merchantId,
    merchantChainId,
    checkoutMode,
    // The skip-logo default: a monogram from the name on the brand color. The
    // Snap/checkout always have something to render — no asset upload needed.
    logoSvgInline: monogramSvg(name, brandColor).svg,
  };
}

/**
 * Seed the ONE featured-merchant branding row from the environment, if enabled.
 *
 * @param upsert - the store's writer (injected to avoid a circular import).
 * @param env - the environment to read (defaults to `process.env`).
 * @returns the seeded row, or null when the seed is disabled or fails soft.
 */
export function seedFeaturedMerchant(
  upsert: (input: BrandingInput) => TenantBranding,
  env: EnvLike = process.env,
): TenantBranding | null {
  try {
    const input = readFeaturedMerchantInput(env);
    if (!input) return null; // env unset ⇒ no-op (open-source default).
    return upsert(input);
  } catch {
    // Fail-soft: a malformed env value must never crash the store at import.
    return null;
  }
}
