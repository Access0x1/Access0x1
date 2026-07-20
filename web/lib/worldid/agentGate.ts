/**
 * agentGate.ts — the Track-A "human-backed agent" trial gate (World ID ADR D6 /
 * unit 7), server-only.
 *
 * AgentKit's mechanic (docs §10): give an autonomous agent an unmetered initial-
 * usage allowance ONLY when it's backed by a verified real human — distinguishing
 * human-backed agents from bot swarms. We implement the verifiable-human half
 * with the SAME `web/lib/worldid/*` seam used for buyer checkout, but a DISTINCT
 * action string (`worldAgentAction()`), so unlocking the agent trial never
 * consumes a buyer's or operator's one-per-human slot.
 *
 * Flow: the agent operator proves personhood once (the agent action) via
 * `/api/world/verify`; that route, on success, calls {@link unlockAgentTrial}.
 * The agent pay route then calls {@link assertAgentTrialAllowed} at the TOP of
 * the handler — when the gate is required, an agent NOT backed by a verified human
 * is blocked; a verified one proceeds.
 *
 * SCOPE (honest — this is a personhood ACCESS gate, not a trial-allowance meter):
 * the only thing enforced here is "is this agent human-backed?". It is DEFENSE-IN-
 * DEPTH behind the real boundary — the fail-closed `x-internal-secret` on the pay
 * route — and the never-negative, durable `agentMeter` owns the ACTUAL spend
 * budget. The `AGENT_TRIAL_CALLS` unmetered-call allowance ({@link agentTrialCalls})
 * is RESERVED config for a future trial tier; it is NOT yet enforced (wiring a real
 * trial tier means skipping the money charge for the first N calls — a money-path
 * change), so this module does not pretend to count it.
 *
 * Enforcement is OPT-IN via `AGENT_REQUIRE_HUMAN` so existing deployments and
 * tests are unaffected by default (fail-soft — like the buyer gate, World ID is
 * never wedged onto a path that didn't ask for it). It never signs, holds, or
 * moves money.
 */

import { assertServerOnly } from '../agent/serverOnly.js'

assertServerOnly('worldid/agentGate')

/** Thrown when an unverified agent hits a trial-gated call and the gate is required. */
export class HumanGateRequired extends Error {
  constructor() {
    super('HumanGateRequired: this agent must be backed by a verified human to use the trial')
    this.name = 'HumanGateRequired'
  }
}

/** Process-lifetime gate state: whether this agent has been proven human-backed. */
interface AgentTrialState {
  unlocked: boolean
}

const state: AgentTrialState = { unlocked: false }

/** Whether the human gate is enforced (opt-in; off by default → fail-soft). */
export function isAgentHumanGateRequired(): boolean {
  return (process.env.AGENT_REQUIRE_HUMAN ?? '').trim().toLowerCase() === 'true'
}

/**
 * The configured trial-tier allowance (`AGENT_TRIAL_CALLS`, default 3). RESERVED: a
 * future trial tier will grant a verified human-backed agent this many unmetered calls.
 * NOT yet enforced by {@link assertAgentTrialAllowed} (that needs a money-path change to
 * skip the charge) — exposed so the config reads cleanly and the future wiring has it.
 */
export function agentTrialCalls(): number {
  const raw = process.env.AGENT_TRIAL_CALLS
  const n = raw === undefined ? 3 : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : 3
}

/**
 * Mark the agent as backed by a verified human (called by `/api/world/verify`
 * after a successful agent-action proof). Idempotent.
 */
export function unlockAgentTrial(): void {
  state.unlocked = true
}

/** Has the agent been verified-human-backed this process? */
export function isAgentTrialUnlocked(): boolean {
  return state.unlocked
}

/**
 * The CHECK the agent pay handler runs before any network effect. When the gate is
 * required and the agent is NOT human-verified, throw — the route maps it to a 402
 * `HumanGateRequired`. When verified (or when the gate is not required), it is a no-op
 * and the request proceeds to the meter. Nothing here counts or caps calls (the meter
 * owns the budget); it is purely the personhood admission check.
 *
 * @throws {HumanGateRequired} when required and the agent is not human-verified.
 */
export function assertAgentTrialAllowed(): void {
  if (!isAgentHumanGateRequired()) return
  if (!state.unlocked) throw new HumanGateRequired()
}

/** Test-only: reset the gate state. NOT used in production paths. */
export function __resetAgentTrialForTests(): void {
  state.unlocked = false
}
