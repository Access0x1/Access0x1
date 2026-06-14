/**
 * casinoBadge.ts — the ONE source of truth for the "Verified Humans Only ·
 * World ID" badge: when it may show, and the exact (truthful) copy (Casino
 * vertical, World prize). Pure, no React, no env reads beyond the World ID
 * configured check — so the component, the API, and the tests all agree.
 *
 * TRUTH (law #4 — this is the critical one): the badge means ONLY that World ID
 * proof-of-personhood has been completed — verified UNIQUE HUMANS, no bots, one
 * account per person. It MUST NOT be read as a gambling licence, age
 * verification, KYC, or any legal-compliance / eligibility claim. The copy below
 * is written to say exactly what World ID proves (personhood + uniqueness) and
 * nothing more.
 */

import type { CheckoutMode } from './store.js';
import { isWorldIdConfigured } from '../worldid/config.js';

/** The headline shown on the chip — what World ID actually proves. */
export const CASINO_BADGE_TITLE = 'Verified Humans Only · World ID';

/**
 * The precise sub-line. States the proof (unique human, one account per person,
 * no bots) and EXPLICITLY disclaims licence / age / eligibility so no reader can
 * mistake personhood for legal compliance.
 */
export const CASINO_BADGE_DETAIL =
  'Every player verified as a unique real person with World ID proof-of-personhood — no bots, one account per person. World ID proves a unique human only; it is not a gambling licence, age check, or eligibility check.';

/** The line shown when the vertical wants the badge but World ID is not set up. */
export const CASINO_BADGE_UNCONFIGURED =
  'World ID required — configure World ID to verify this casino.';

/** The minimal branding shape the badge needs (decoupled from the full row). */
export interface CasinoBadgeInput {
  /** True once the operator completed World ID proof-of-personhood. */
  verifiedOperator?: boolean | null;
  /** The checkout mode — must be 'verified-human' for the badge to issue. */
  checkoutMode?: CheckoutMode | string | null;
}

/**
 * May the "Verified Humans Only · World ID" badge render for this merchant?
 *
 * BOTH conditions must hold (the prompt's gate):
 *   1. `verifiedOperator === true`  — a real, unique human completed World ID,
 *   2. `checkoutMode === 'verified-human'` — players pass the World ID gate.
 *
 * AND World ID must be configured (`worldConfigured`, default = live env check):
 * if World ID isn't switched on we can never have truthfully verified anyone, so
 * the badge is NEVER issued — it fails soft to "configure to verify" instead of
 * faking a green check (law #4 / fail-soft).
 *
 * @param input - the merchant's verifiedOperator + checkoutMode.
 * @param worldConfigured - whether World ID is configured (injectable for tests).
 * @returns true only when all three hold.
 */
export function canShowCasinoBadge(
  input: CasinoBadgeInput,
  worldConfigured: boolean = isWorldIdConfigured(),
): boolean {
  return (
    worldConfigured &&
    input.verifiedOperator === true &&
    input.checkoutMode === 'verified-human'
  );
}
