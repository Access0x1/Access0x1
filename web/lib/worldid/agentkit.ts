/**
 * agentkit.ts — the human-backed-agent ADMISSION adapter (World AgentKit seam),
 * server-only.
 *
 * PRODUCT TRUTH: an autonomous agent should prove that a real, unique human stands
 * behind it BEFORE it is granted execution rights (the ability to spend). This is
 * World's "AgentKit" idea — proof-of-human for the agentic web — expressed against
 * the SAME `web/lib/worldid/*` verify seam the buyer checkout uses, but scoped to a
 * DISTINCT delegation action (`worldAgentKitAction()`), so a human delegating to an
 * agent never consumes a buyer's or operator's one-per-human slot.
 *
 * TWO DRIVERS (the established fail-soft precedent — see `config.ts` / `gateConfig.ts`):
 *   - LIVE — engaged when World ID is configured (`isWorldIdConfigured()`): the raw
 *     delegation proof is forwarded to the Developer Portal verify endpoint via the
 *     shared {@link verifyWorldProof} (DRY — the same byte-for-byte forward the buyer
 *     gate uses), scoped to the distinct `WORLD_AGENTKIT_ACTION`. A 200 with a
 *     nullifier ⇒ human-backed; anything else ⇒ rejected with a machine code.
 *   - SIMULATOR — when no `app_` id is configured (dev/demo/testnet default): a
 *     clearly-flagged `simulated: true` pass, so the delegation flow is exercisable
 *     without a real Developer-Portal app. Honesty law: a simulated result is NEVER
 *     a real proof, and it says so on its face.
 *
 * NO NPM DEPENDENCY (repo law): the official `@worldcoin/agentkit` client
 * (`createAgentkitHooks` / AgentBook lookup on World Chain) is NOT added here — the
 * import surface is modeled behind this adapter against the verify endpoint we
 * already own, and adopting the real client is a documented follow-up. This adapter
 * NEVER signs, holds, or moves money; it is a pure verify + a pure state mapper.
 */

import { assertServerOnly } from '../agent/serverOnly.js'
import { isWorldIdConfigured, worldAgentKitAction } from './config.js'
import { verifyWorldProof } from './verify.js'

assertServerOnly('worldid/agentkit')

/**
 * The outcome of a human-backed-agent verification — a single flat shape so the
 * execution-rights policy consumes it with one branch (`humanBacked`).
 */
export interface HumanBackedAgentResult {
  /** True when a real, unique human is proven to stand behind this agent. */
  humanBacked: boolean
  /**
   * True when the SIMULATOR driver produced this result (World ID unconfigured).
   * Honesty flag — a simulated pass is a dev affordance, never a real proof; it is
   * carried through so callers/telemetry can distinguish it and never claim a live
   * verification that did not happen.
   */
  simulated: boolean
  /** The delegation action the proof was scoped to (the distinct AgentKit action). */
  action: string
  /** The nullifier from a live proof; null for the simulator or a rejection. */
  nullifier: string | null
  /** A machine code explaining WHY `humanBacked` is false (absent on success). */
  code?: string
}

/** Thrown when {@link verifyHumanBackedAgent} is called with no proof payload (fail-fast). */
export class AgentProofRequiredError extends Error {
  constructor() {
    super('AgentProofRequiredError: a delegation proof payload is required to verify a human-backed agent')
    this.name = 'AgentProofRequiredError'
  }
}

/**
 * Is the LIVE driver engaged? True only when World ID is configured (public app id
 * + rp id present). Otherwise {@link verifyHumanBackedAgent} uses the simulator.
 * Exposed so a caller (or a test) can assert which driver a deployment will run.
 *
 * @returns true when the live Developer-Portal verify path is active.
 */
export function isAgentKitLiveConfigured(): boolean {
  return isWorldIdConfigured()
}

/**
 * Verify that a real, unique human stands behind an agent, from a raw delegation
 * proof payload. Picks the live or simulator driver by deployment config.
 *
 * @param proofPayload - the raw IDKit/AgentKit delegation proof, forwarded AS-IS to
 *        the portal (no field remap — a mutation ⇒ verification_failed, per the docs).
 * @returns the flat {@link HumanBackedAgentResult} (live or clearly-simulated).
 * @throws {AgentProofRequiredError} when `proofPayload` is null/undefined.
 */
export async function verifyHumanBackedAgent(proofPayload: unknown): Promise<HumanBackedAgentResult> {
  // Fail-fast: never forward an empty body or treat "no proof" as a pass.
  if (proofPayload === undefined || proofPayload === null) {
    throw new AgentProofRequiredError()
  }

  const action = worldAgentKitAction()

  if (isAgentKitLiveConfigured()) {
    // LIVE: reuse the shared verify (DRY) scoped to the DISTINCT delegation action.
    const res = await verifyWorldProof(proofPayload, action)
    if (res.ok) {
      return { humanBacked: true, simulated: false, action: res.action, nullifier: res.nullifier }
    }
    return { humanBacked: false, simulated: false, action, nullifier: null, code: res.code }
  }

  // SIMULATOR: no app_ id configured ⇒ a clearly-flagged simulated pass (fail-soft
  // precedent). In production `isWorldIdConfigured()` is true, so the live driver runs.
  return { humanBacked: true, simulated: true, action, nullifier: null }
}

/**
 * Map the process-level admission state (has this agent already proven human-backed
 * this process, via the verify route?) into a {@link HumanBackedAgentResult} the
 * execution-rights policy can consume — WITHOUT re-verifying a proof in the hot pay
 * path. This is the bridge the agent-pay route uses: it reads the established
 * admission signal, not a fresh network verify.
 *
 * The `simulated` flag reflects the DEPLOYMENT (World ID unconfigured ⇒ any unlock
 * came from a simulated/dev flow), kept honest and separate from the tier decision.
 *
 * @param unlocked - whether the agent is admission-unlocked (human-backed) this process.
 * @returns the flat result: `humanBacked` mirrors `unlocked`.
 */
export function humanBackedFromAdmission(unlocked: boolean): HumanBackedAgentResult {
  const simulated = !isWorldIdConfigured()
  return {
    humanBacked: unlocked,
    simulated,
    action: worldAgentKitAction(),
    nullifier: null,
    code: unlocked ? undefined : 'not_admitted',
  }
}
