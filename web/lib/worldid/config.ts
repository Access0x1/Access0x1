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

/** The IDKit `environment`. Dev uses the Worldcoin Simulator under "staging". */
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
 * readable constant so it works before the env is set; override per
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

/**
 * The distinct action string scoping AgentKit-style DELEGATION proofs — the proof
 * a verified human signs to stand behind an autonomous agent BEFORE it earns
 * execution rights (World's AgentKit / "proof of human for the agentic web").
 *
 * It is its OWN action, separate from the buyer gate, the operator badge, AND the
 * reserved `worldAgentAction()` trial-unlock: a human delegating to an agent must
 * never consume a checkout's one-per-human slot, and the delegation nullifier
 * lives in its own `worldid:<action>` namespace. Defaults to a readable constant so
 * the dev/simulator flow works before the env is set; override per deployment via
 * `WORLD_AGENTKIT_ACTION`. Consumed by {@link verifyHumanBackedAgent}'s live driver.
 */
export function worldAgentKitAction(): string {
  return (process.env.WORLD_AGENTKIT_ACTION ?? 'agentkit-human-backed').trim()
}

/**
 * The gates a client may ASK to be signed for. An enum, never a free action
 * string: the client picks a NAMED gate and the server alone decides which
 * action that gate means. This is the same C-2 discipline `/api/world/verify`
 * applies to its own body, lifted to one shared map so the signing side and the
 * verifying side can never drift apart.
 */
export type WorldGate = 'buyer' | 'operator' | 'agent' | 'agentkit'

/** Every gate name the server recognises. The one list `isWorldGate` reads. */
export const WORLD_GATES: readonly WorldGate[] = ['buyer', 'operator', 'agent', 'agentkit']

/**
 * Is `raw` one of the named gates? A type guard, so a caller can tell
 * "unrecognised" apart from "recognised but not served here" — the distinction
 * {@link asWorldGate} deliberately erases.
 *
 * @param raw - untrusted value (a query param, a body field).
 * @returns true when `raw` is a {@link WorldGate}.
 */
export function isWorldGate(raw: unknown): raw is WorldGate {
  return typeof raw === 'string' && (WORLD_GATES as readonly string[]).includes(raw)
}

/**
 * Coerce untrusted input to a {@link WorldGate}, defaulting to the buyer gate.
 * Anything unrecognised falls back to `buyer` — a request can never widen its
 * own scope by inventing a gate name.
 *
 * WHERE THIS IS THE RIGHT CALL, and where it is not. Narrowing to `buyer` is
 * safe for `/api/world/sign`, whose whole job is to mint an RP context for the
 * gate it resolves and which echoes that gate back, so the widget follows the
 * server's choice and the two agree by construction. A VERIFY route must not
 * use it: there the proof already exists, bound to `hash(app_id, action)` for
 * the gate the client asked to sign, so silently re-reading it under the buyer
 * action produces a mystery 401 `proof_invalid` — the exact mismatch the
 * sign/verify action map exists to make impossible. Verify routes use
 * {@link isWorldGate} and REFUSE a gate they do not serve.
 *
 * @param raw - untrusted value (a query param, a body field).
 * @returns the recognised gate, or `'buyer'`.
 */
export function asWorldGate(raw: unknown): WorldGate {
  return isWorldGate(raw) ? raw : 'buyer'
}

/**
 * The server-configured action string for a gate — THE single source of truth.
 *
 * Why this matters: a World ID proof is bound to `hash(app_id, action)`. The RP
 * context minted by `/api/world/sign` is signed for one action, the widget
 * generates the proof against one action, and the verify route claims the
 * nullifier under one action. Those three MUST be the same string. Reading the
 * action from one shared server function — and shipping it back to the client in
 * the sign response — makes a mismatch impossible by construction, rather than a
 * silent `proof_invalid` an operator has to debug.
 *
 * @param gate - the named gate.
 * @returns the configured action string for that gate.
 */
export function worldGateAction(gate: WorldGate): string {
  switch (gate) {
    case 'operator':
      return worldOperatorAction()
    case 'agent':
      return worldAgentAction()
    case 'agentkit':
      return worldAgentKitAction()
    default:
      return worldAction()
  }
}
