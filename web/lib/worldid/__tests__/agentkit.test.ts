/**
 * agentkit.test.ts — the human-backed-agent admission adapter (agentkit.ts) + the
 * execution-rights policy (agentPolicy.ts).
 *
 * Pins:
 *   - the adapter defaults to the SIMULATOR driver when World ID is unconfigured,
 *     and flags the result `simulated: true` (honesty — never a real proof),
 *   - fail-fast: a null/undefined proof payload throws AgentProofRequiredError,
 *   - the LIVE driver forwards to the Developer-Portal verify endpoint scoped to the
 *     DISTINCT AgentKit delegation action (mocked fetch), and maps rejections,
 *   - the admission-state bridge maps unlocked→human-backed / locked→not_admitted,
 *   - the policy grants a human-backed agent the elevated cap + `human-backed` tier
 *     and an unverified one the conservative cap + `unverified` tier (env-tunable),
 *   - assertWithinSessionCap is a no-op under the cap and throws over it with the
 *     requested/cap/tier carried through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AgentProofRequiredError,
  humanBackedFromAdmission,
  isAgentKitLiveConfigured,
  verifyHumanBackedAgent,
} from '../agentkit.js'
import {
  DEFAULT_HUMAN_SESSION_CAP_USD,
  DEFAULT_UNVERIFIED_SESSION_CAP_USD,
  SessionBudgetCapExceeded,
  assertWithinSessionCap,
  isAgentSessionCapEnforced,
  resolveExecutionRights,
} from '../agentPolicy.js'
import type { HumanBackedAgentResult } from '../agentkit.js'

const ENV_KEYS = [
  'NEXT_PUBLIC_WORLD_APP_ID',
  'WORLD_RP_ID',
  'NEXT_PUBLIC_WORLD_ENVIRONMENT',
  'WORLD_AGENTKIT_ACTION',
  'AGENT_SESSION_CAP_ENFORCED',
  'AGENT_SESSION_CAP_HUMAN_USD',
  'AGENT_SESSION_CAP_DEFAULT_USD',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A configured deployment: `app_` id + rp id present ⇒ the LIVE driver engages. */
function configureWorldId(): void {
  process.env.NEXT_PUBLIC_WORLD_APP_ID = 'app_test123'
  process.env.WORLD_RP_ID = 'rp_test'
}

describe('verifyHumanBackedAgent — driver selection', () => {
  it('defaults to the SIMULATOR driver when World ID is unconfigured (simulated:true)', async () => {
    expect(isAgentKitLiveConfigured()).toBe(false)
    const r = await verifyHumanBackedAgent({ proof: '0xabc' })
    expect(r.humanBacked).toBe(true)
    expect(r.simulated).toBe(true)
    expect(r.nullifier).toBeNull()
    expect(r.action).toBe('agentkit-human-backed')
  })

  it('fail-fast: throws AgentProofRequiredError on a null/undefined payload', async () => {
    await expect(verifyHumanBackedAgent(null)).rejects.toThrow(AgentProofRequiredError)
    await expect(verifyHumanBackedAgent(undefined)).rejects.toThrow(AgentProofRequiredError)
  })

  it('LIVE driver forwards to the portal scoped to the DISTINCT AgentKit action (mocked fetch)', async () => {
    configureWorldId()
    process.env.WORLD_AGENTKIT_ACTION = 'agentkit-delegation-xyz'
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ nullifier: '0x2a' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await verifyHumanBackedAgent({ merkle_root: '0x1', proof: '0x2', nullifier_hash: '0x2a' })

    expect(isAgentKitLiveConfigured()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v4/verify/rp_test')
    expect(r.humanBacked).toBe(true)
    expect(r.simulated).toBe(false)
    expect(r.nullifier).toBe('0x2a')
    // The distinct delegation action is the scope this proof was verified under.
    expect(r.action).toBe('agentkit-delegation-xyz')
  })

  it('LIVE driver maps a portal rejection to humanBacked:false with a machine code', async () => {
    configureWorldId()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ code: 'invalid_proof' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await verifyHumanBackedAgent({ proof: '0xbad' })
    expect(r.humanBacked).toBe(false)
    expect(r.simulated).toBe(false)
    expect(r.code).toBe('invalid_proof')
    expect(r.nullifier).toBeNull()
  })
})

describe('humanBackedFromAdmission — the admission-state bridge', () => {
  it('unlocked → humanBacked:true (no rejection code)', () => {
    const r = humanBackedFromAdmission(true)
    expect(r.humanBacked).toBe(true)
    expect(r.code).toBeUndefined()
  })

  it('locked → humanBacked:false with a not_admitted code', () => {
    const r = humanBackedFromAdmission(false)
    expect(r.humanBacked).toBe(false)
    expect(r.code).toBe('not_admitted')
  })

  it('simulated reflects the deployment (unconfigured ⇒ true, configured ⇒ false)', () => {
    expect(humanBackedFromAdmission(true).simulated).toBe(true)
    configureWorldId()
    expect(humanBackedFromAdmission(true).simulated).toBe(false)
  })
})

/** A minimal verified/unverified result literal for the pure policy tests. */
function result(humanBacked: boolean): HumanBackedAgentResult {
  return { humanBacked, simulated: false, action: 'agentkit-human-backed', nullifier: null }
}

describe('resolveExecutionRights — tiers + env-tunable caps', () => {
  it('human-backed → elevated cap + human-backed tier (default)', () => {
    const rights = resolveExecutionRights(result(true))
    expect(rights.authorizationTier).toBe('human-backed')
    expect(rights.maxSessionBudgetUsd).toBe(DEFAULT_HUMAN_SESSION_CAP_USD)
  })

  it('unverified → conservative cap + unverified tier (default)', () => {
    const rights = resolveExecutionRights(result(false))
    expect(rights.authorizationTier).toBe('unverified')
    expect(rights.maxSessionBudgetUsd).toBe(DEFAULT_UNVERIFIED_SESSION_CAP_USD)
  })

  it('a simulated verified result still maps to the human-backed tier', () => {
    const simulated: HumanBackedAgentResult = {
      humanBacked: true,
      simulated: true,
      action: 'agentkit-human-backed',
      nullifier: null,
    }
    expect(resolveExecutionRights(simulated).authorizationTier).toBe('human-backed')
  })

  it('env overrides both caps', () => {
    process.env.AGENT_SESSION_CAP_HUMAN_USD = '12.5'
    process.env.AGENT_SESSION_CAP_DEFAULT_USD = '0.25'
    expect(resolveExecutionRights(result(true)).maxSessionBudgetUsd).toBe(12.5)
    expect(resolveExecutionRights(result(false)).maxSessionBudgetUsd).toBe(0.25)
  })

  it('a malformed or non-positive cap env falls back to the safe default', () => {
    process.env.AGENT_SESSION_CAP_HUMAN_USD = 'not-a-number'
    process.env.AGENT_SESSION_CAP_DEFAULT_USD = '-5'
    expect(resolveExecutionRights(result(true)).maxSessionBudgetUsd).toBe(DEFAULT_HUMAN_SESSION_CAP_USD)
    expect(resolveExecutionRights(result(false)).maxSessionBudgetUsd).toBe(DEFAULT_UNVERIFIED_SESSION_CAP_USD)
  })
})

describe('assertWithinSessionCap', () => {
  it('is a no-op at or under the cap', () => {
    const rights = { maxSessionBudgetUsd: 1, authorizationTier: 'human-backed' as const }
    expect(() => assertWithinSessionCap(1, rights)).not.toThrow()
    expect(() => assertWithinSessionCap(0.5, rights)).not.toThrow()
  })

  it('throws SessionBudgetCapExceeded over the cap, carrying requested/cap/tier', () => {
    const rights = { maxSessionBudgetUsd: 1, authorizationTier: 'unverified' as const }
    let thrown: unknown
    try {
      assertWithinSessionCap(2, rights)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SessionBudgetCapExceeded)
    expect((thrown as SessionBudgetCapExceeded).requestedUsd).toBe(2)
    expect((thrown as SessionBudgetCapExceeded).capUsd).toBe(1)
    expect((thrown as SessionBudgetCapExceeded).tier).toBe('unverified')
  })
})

describe('isAgentSessionCapEnforced — opt-in flag', () => {
  it('is off by default and on only for a true value (case-insensitive)', () => {
    expect(isAgentSessionCapEnforced()).toBe(false)
    process.env.AGENT_SESSION_CAP_ENFORCED = 'true'
    expect(isAgentSessionCapEnforced()).toBe(true)
    process.env.AGENT_SESSION_CAP_ENFORCED = 'TRUE'
    expect(isAgentSessionCapEnforced()).toBe(true)
    process.env.AGENT_SESSION_CAP_ENFORCED = 'yes'
    expect(isAgentSessionCapEnforced()).toBe(false)
  })
})
