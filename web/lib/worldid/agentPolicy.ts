/**
 * agentPolicy.ts — the execution-rights policy for a (human-backed | unverified)
 * agent. An ADMISSION-layer decision consumed BEFORE settlement; the settlement CEI
 * core (`router.payToken`/`payNative`, `payPerCall`, the durable `agentMeter`) is
 * NEVER touched by this file.
 *
 * PRODUCT TRUTH: once an agent proves a real human stands behind it
 * ({@link HumanBackedAgentResult} from `agentkit.ts`), it earns DIFFERENTIATED
 * execution terms — an elevated per-session budget cap. An unverified agent gets a
 * conservative default cap. Both caps are env-config (never hardcoded secrets); the
 * mapping from verification → tier → cap is a pure, deterministic function.
 *
 * SCOPE (honest): this is a per-SESSION budget CEILING only. It does NOT implement
 * free-trial call allowances or per-call discounts — the reserved `AGENT_TRIAL_CALLS`
 * mechanic in `agentGate.ts` stays RESERVED-not-enforced (wiring a trial tier is a
 * money-path change, out of scope here). The durable `agentMeter` still owns the real
 * spend budget; this cap is defense-in-depth admission on TOP of it, never in place of it.
 */

import type { HumanBackedAgentResult } from './agentkit.js'

/** The two admission tiers a caller is placed in by its verification outcome. */
export type AuthorizationTier = 'human-backed' | 'unverified'

/** The differentiated execution terms a tier is granted for a session. */
export interface ExecutionRights {
  /** The maximum USD this session may request to spend (an admission ceiling). */
  maxSessionBudgetUsd: number
  /** Which tier produced these terms (for the response body + telemetry). */
  authorizationTier: AuthorizationTier
}

/** Default elevated cap (USD) for a human-backed agent when the env is unset. */
export const DEFAULT_HUMAN_SESSION_CAP_USD = 5.0
/** Default conservative cap (USD) for an unverified agent when the env is unset. */
export const DEFAULT_UNVERIFIED_SESSION_CAP_USD = 0.5

/**
 * Read a positive-number USD cap from an env var, falling back to `fallback` on an
 * unset, malformed, non-finite, or non-positive value (fail-soft — a bad env never
 * removes the ceiling, it reverts to the safe default).
 *
 * @param name - the env var name to read.
 * @param fallback - the default cap when the env is absent or invalid.
 * @returns the resolved positive cap in USD.
 */
function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Is the per-session budget-cap policy ENFORCED on the agent-pay path? Opt-in via
 * `AGENT_SESSION_CAP_ENFORCED=true`; off by default so an existing deployment behaves
 * EXACTLY as it does today (the policy is fully dormant + removable when off).
 *
 * @returns true when the route should apply {@link assertWithinSessionCap}.
 */
export function isAgentSessionCapEnforced(): boolean {
  return (process.env.AGENT_SESSION_CAP_ENFORCED ?? '').trim().toLowerCase() === 'true'
}

/**
 * Resolve the execution terms for a verification outcome — the pure policy core.
 * A human-backed result ⇒ the elevated cap + `human-backed` tier; anything else ⇒
 * the conservative cap + `unverified` tier. Deterministic given the env caps.
 *
 * A `simulated: true` verified result still maps to the human-backed tier: the
 * simulator only runs when World ID is unconfigured (dev/demo), and the flag is
 * carried honestly upstream — it never silently downgrades the terms in that context.
 *
 * @param result - the verification outcome from `agentkit.ts`.
 * @returns the {@link ExecutionRights} for the session.
 */
export function resolveExecutionRights(result: HumanBackedAgentResult): ExecutionRights {
  if (result.humanBacked) {
    return {
      maxSessionBudgetUsd: capFromEnv('AGENT_SESSION_CAP_HUMAN_USD', DEFAULT_HUMAN_SESSION_CAP_USD),
      authorizationTier: 'human-backed',
    }
  }
  return {
    maxSessionBudgetUsd: capFromEnv('AGENT_SESSION_CAP_DEFAULT_USD', DEFAULT_UNVERIFIED_SESSION_CAP_USD),
    authorizationTier: 'unverified',
  }
}

/** Thrown when a session's requested budget exceeds its tier's cap (mapped to 402). */
export class SessionBudgetCapExceeded extends Error {
  /** The USD the session asked to be allowed to spend. */
  readonly requestedUsd: number
  /** The tier's cap the request exceeded. */
  readonly capUsd: number
  /** The tier that produced the cap (for the response body). */
  readonly tier: AuthorizationTier

  constructor(requestedUsd: number, rights: ExecutionRights) {
    super(
      `SessionBudgetCapExceeded: requested ${requestedUsd} exceeds the ${rights.authorizationTier} cap ${rights.maxSessionBudgetUsd}`,
    )
    this.name = 'SessionBudgetCapExceeded'
    this.requestedUsd = requestedUsd
    this.capUsd = rights.maxSessionBudgetUsd
    this.tier = rights.authorizationTier
  }
}

/**
 * Assert a session's requested USD is within its tier's cap. A no-op when at or under
 * the cap; throws {@link SessionBudgetCapExceeded} when over. Mirrors the
 * `assertAgentTrialAllowed()` idiom so the route try/catches it into a 402.
 *
 * @param requestedUsd - the session's total requested spend (price × count).
 * @param rights - the resolved execution terms for the caller's tier.
 * @throws {SessionBudgetCapExceeded} when `requestedUsd` exceeds the cap.
 */
export function assertWithinSessionCap(requestedUsd: number, rights: ExecutionRights): void {
  if (requestedUsd > rights.maxSessionBudgetUsd) {
    throw new SessionBudgetCapExceeded(requestedUsd, rights)
  }
}
