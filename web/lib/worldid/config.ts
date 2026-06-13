/**
 * config.ts — the World ID env seam (ADR D2).
 *
 * One place reads the four Developer-Portal values, so a version/key change
 * touches this file only. Mirrors how Dynamic is isolated in `lib/dynamic.ts`
 * and Unlink in `lib/unlink/*`. Nothing here is hardcoded (doctrine guardrail
 * #5 / secrets law): every value comes from env, and the only client-visible
 * one is the public `app_id` (`NEXT_PUBLIC_*`). The signing key is read ONLY by
 * the server `/sign` route via {@link worldSigningKey} and never bundled.
 *
 * Honesty: until the booth confirms the real Developer-Portal app, these are
 * blank placeholders. A blank `app_id`/`signing_key` makes World ID UNAVAILABLE
 * (fail-soft) — the checkout simply behaves as "standard" rather than throwing,
 * exactly like the branding payload degrading to USD-only when the router env is
 * unset (`response.ts` law #4).
 */

/** The IDKit `environment`. Demo uses the Worldcoin Simulator under "staging". */
export type WorldEnvironment = 'staging' | 'production'

/** The off-chain Developer Portal verify base (production). */
export const WORLD_VERIFY_BASE_PRODUCTION = 'https://developer.world.org'
/** The off-chain Developer Portal verify base (staging / simulator). */
export const WORLD_VERIFY_BASE_STAGING = 'https://staging-developer.worldcoin.org'

/**
 * The PUBLIC World ID app id (`app_...`), safe in the client bundle. Blank until
 * the Developer Portal app is confirmed at the booth — blank ⇒ World ID OFF.
 */
export function worldAppId(): string {
  return (process.env.NEXT_PUBLIC_WORLD_APP_ID ?? '').trim()
}

/**
 * The RP id (`rp_...`, `app_...` accepted for back-compat). PUBLIC — it goes in
 * the `rp_context` the widget reads and in the `/verify/{rp_id}` URL.
 */
export function worldRpId(): string {
  return (process.env.WORLD_RP_ID ?? '').trim()
}

/**
 * The action string scoping the buyer gate (`hash(app_id, action)` →
 * externalNullifier). One human can clear this action once. Defaults to a
 * readable constant so the demo works before the env is set; override per
 * deployment via `WORLD_ACTION`.
 */
export function worldAction(): string {
  return (process.env.WORLD_ACTION ?? 'checkout-verified-human').trim()
}

/**
 * The SERVER-ONLY signing key (secrets law). Throws if read in the browser —
 * a `NEXT_PUBLIC_` leak is a hard error, not a silent downgrade. Only the
 * `/api/world/sign` route calls this.
 *
 * @returns the signing key hex, or '' when unset (⇒ World ID unavailable).
 * @throws if accessed from a client bundle.
 */
export function worldSigningKey(): string {
  if (typeof window !== 'undefined') {
    throw new Error('WORLD_SIGNING_KEY must never be read in the browser (secrets law).')
  }
  return (process.env.WORLD_SIGNING_KEY ?? '').trim()
}

/** The IDKit environment — "staging" unless explicitly set to "production". */
export function worldEnvironment(): WorldEnvironment {
  return (process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT ?? '').trim() === 'production'
    ? 'production'
    : 'staging'
}

/** The Developer-Portal verify base for the current environment. */
export function worldVerifyBase(): string {
  return worldEnvironment() === 'production'
    ? WORLD_VERIFY_BASE_PRODUCTION
    : WORLD_VERIFY_BASE_STAGING
}

/**
 * Is World ID configured enough to run the buyer gate? The PUBLIC half — the
 * client uses this to decide whether to even mount the widget. Requires the
 * public app id and the rp id; the (server-only) signing key is checked
 * separately inside the `/sign` route so it never influences a client check.
 *
 * @returns true when `app_id` and `rp_id` are both present.
 */
export function isWorldIdConfigured(): boolean {
  return worldAppId().startsWith('app_') && worldRpId().length > 0
}

/**
 * The distinct action string for the merchant-operator "verified human"
 * onboarding badge (ADR D1.4). A SEPARATE action from the buyer gate so the two
 * nullifier spaces never collide.
 */
export function worldOperatorAction(): string {
  return (process.env.WORLD_OPERATOR_ACTION ?? 'verified-operator').trim()
}

/**
 * The distinct action string for the Track-A human-backed agent trial gate
 * (ADR D6 / unit 7). Again separate, so unlocking the agent trial never
 * consumes a buyer's or operator's one-per-human slot.
 */
export function worldAgentAction(): string {
  return (process.env.WORLD_AGENT_ACTION ?? 'agent-trial-unlock').trim()
}
