/**
 * gateConfig.ts — resolve a merchant's checkout mode (World ID ADR D2 / D4).
 *
 * The ONE place the checkout asks "what does this merchant want — verified
 * humans, private, or standard?". It reads the per-merchant flag off the
 * existing `tenant_branding` row (the same store the white-label ADR owns) and
 * enforces the D0 mutual-exclusion rule: a single checkout is identity OR
 * privacy, never both. World ID and Unlink are opposite poles; this resolver is
 * where the contradiction is settled to exactly one mode.
 *
 * It is pure config-resolution: it never mounts a widget, calls the portal, or
 * touches money. The checkout (`CheckoutCard`) consumes the returned mode to
 * decide whether to render the gate, run the Unlink leg, or do nothing.
 */

import { asCheckoutMode, type CheckoutMode, type HumanVerifier } from '../branding/store.js'
import { isWorldIdConfigured } from './config.js'

/** The resolved gate decision for a checkout. */
export interface GateDecision {
  /** The mode to apply — one and only one (mutual exclusion enforced). */
  mode: CheckoutMode
  /** Where to check a verified-human proof (only used when mode = verified-human). */
  verifier: HumanVerifier
  /**
   * True when mode = verified-human BUT World ID is not configured (no app id /
   * rp id). Fail-soft: the checkout treats this as 'standard' so a missing env
   * never blocks a payment (ADR D7 — the gate is off the money path, and a
   * World ID outage cannot block a payment), but the UI can note it.
   */
  degradedToStandard: boolean
}

/** The minimal branding shape this resolver needs (decoupled from the full row). */
export interface GateBrandingLike {
  checkoutMode?: CheckoutMode | string | null
  humanVerifier?: HumanVerifier | string | null
}

/**
 * Resolve the effective gate decision from a branding row (or null).
 *
 * Rules (D0 mutual exclusion + D7 fail-soft):
 *  - No branding row, or mode 'standard' → standard (today's path).
 *  - mode 'private' → private (the Unlink leg); World ID is never mounted.
 *  - mode 'verified-human' → verified-human IFF World ID is configured;
 *    otherwise degrade to standard (never block pay on a missing env).
 *
 * @param branding - the tenant branding row, or null when none exists yet.
 * @returns the single resolved mode + verifier + degraded flag.
 */
export function resolveGate(branding: GateBrandingLike | null): GateDecision {
  const mode = asCheckoutMode(branding?.checkoutMode)
  const verifier: HumanVerifier = branding?.humanVerifier === 'onchain' ? 'onchain' : 'offchain'

  if (mode === 'verified-human') {
    if (!isWorldIdConfigured()) {
      return { mode: 'standard', verifier, degradedToStandard: true }
    }
    return { mode: 'verified-human', verifier, degradedToStandard: false }
  }

  // 'private' and 'standard' pass through unchanged. They never mount the gate,
  // so they don't care whether World ID is configured.
  return { mode, verifier, degradedToStandard: false }
}
