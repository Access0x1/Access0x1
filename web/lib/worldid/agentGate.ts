/**
 * agentGate.ts — the Track-A "human-backed agent" trial gate (World ID ADR D6 /
 * unit 7), server-only.
 *
 * AgentKit's mechanic (docs §10): give an autonomous agent a free initial-usage
 * allowance ONLY when it's backed by a verified real human — distinguishing
 * human-backed agents from bot swarms. We implement the verifiable-human half
 * with the SAME `web/lib/worldid/*` seam used for buyer checkout, but a DISTINCT
 * action string (`worldAgentAction()`), so unlocking the agent trial never
 * consumes a buyer's or operator's one-per-human slot.
 *
 * Flow: the agent operator proves personhood once (the agent action) via
 * `/api/world/verify`; that route, on success, calls {@link unlockAgentTrial}.
 * The agent pay route then calls {@link assertAgentTrialAllowed} at the TOP of
 * the handler — a verified agent gets `AGENT_TRIAL_CALLS` free calls before the
 * meter/x402 charging kicks in; an unverified agent is blocked when the gate is
 * required.
 *
 * Enforcement is OPT-IN via `AGENT_REQUIRE_HUMAN` so existing deployments and
 * tests are unaffected by default (fail-soft — like the buyer gate, World ID is
 * never wedged onto a path that didn't ask for it). It is a pure trial GATE: it
 * never signs, holds, or moves money; the never-negative `agentMeter` still owns
 * the actual budget.
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

/** Process-lifetime trial state (mirrors agentMeter's in-process ledger). */
interface AgentTrialState {
  unlocked: boolean
  trialCallsUsed: number
}

const state: AgentTrialState = { unlocked: false, trialCallsUsed: 0 }

/** Whether the human gate is enforced (opt-in; off by default → fail-soft). */
export function isAgentHumanGateRequired(): boolean {
  return (process.env.AGENT_REQUIRE_HUMAN ?? '').trim().toLowerCase() === 'true'
}

/** The number of free trial calls a verified-human-backed agent gets. */
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
 * The CHECK the agent pay handler runs before any network effect. When the gate
 * is required and the agent is NOT verified, throw — the route maps it to a 402
 * `HumanGateRequired`. When verified, count the call against the trial allowance
 * (informational; the never-negative meter still owns the real budget). When the
 * gate is not required, this is a no-op (existing behavior preserved).
 *
 * @throws {HumanGateRequired} when required and the agent is not verified.
 */
export function assertAgentTrialAllowed(): void {
  if (!isAgentHumanGateRequired()) return
  if (!state.unlocked) throw new HumanGateRequired()
  state.trialCallsUsed += 1
}

/** Test-only: reset the trial state. NOT used in production paths. */
export function __resetAgentTrialForTests(): void {
  state.unlocked = false
  state.trialCallsUsed = 0
}
