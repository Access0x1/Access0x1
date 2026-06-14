/**
 * store.ts — per-user verification profile store (the Super Verification seam).
 *
 * Mirrors the existing in-memory, globalThis-pinned singletons in the repo
 * (`lib/branding/store.ts`, `lib/worldid/nullifierStore.ts`): the hackathon repo
 * has no database, so a process-lifetime Map keyed by the user's lowercased
 * wallet address holds each user's completed verification methods. The interface
 * (`getProfile` / `addMethod` / `setMethods`) is the SEAM a real KV/Postgres
 * `verification_profile(user PK, methods JSONB)` table swaps behind later with
 * zero call-site changes.
 *
 * It stores ONLY the set of methods the user has genuinely passed; the score and
 * tier are always DERIVED from `lib/verification/tiers.ts`, never persisted, so a
 * weighting change never needs a data migration.
 */

import {
  asVerificationMethod,
  emptyProfile,
  normalizeMethods,
  type VerificationMethod,
  type VerificationProfile,
} from './tiers.js'

interface ProfileStore {
  /** Keyed by a lowercased wallet address — the USER (human) profile. */
  byUser: Map<string, VerificationProfile>
  /** Keyed by a lowercased bytes32 agentId — the AGENT (delegate) profile. */
  byAgent: Map<string, VerificationProfile>
}

/** Pin ONE store on globalThis so dev hot-reload / route instances share it. */
const GLOBAL_KEY = '__ax1_verification_store__'

function store(): ProfileStore {
  const g = globalThis as unknown as Record<string, ProfileStore | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { byUser: new Map(), byAgent: new Map() }
  const s = g[GLOBAL_KEY] as Partial<ProfileStore>
  // Defensive: an older pinned store (pre-agent) may lack `byAgent` after a hot
  // reload — backfill it so agent reads/writes never hit `undefined`.
  if (!s.byUser) s.byUser = new Map()
  if (!s.byAgent) s.byAgent = new Map()
  return s as ProfileStore
}

/** Normalize a user key to a stable lowercased wallet address, or throw. */
export function normalizeUserKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('verification: user key is required')
  const id = raw.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(id)) throw new Error('verification: user key must be a wallet address')
  return id
}

/**
 * Normalize an AGENT key to a stable lowercased bytes32 `agentId`
 * (= keccak256(owner, delegate); see `lib/agent/identity.ts`), or throw. The agent
 * profile is keyed by THIS, distinct from a wallet address, so "this agent is
 * Google-verified" is durably queryable independent of any single user wallet.
 */
export function normalizeAgentKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('verification: agent key is required')
  const id = raw.trim().toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error('verification: agent key must be a bytes32 agent id')
  return id
}

/** Read a user's verification profile (empty when they have verified nothing). */
export function getProfile(user: string): VerificationProfile {
  const key = normalizeUserKey(user)
  const existing = store().byUser.get(key)
  return existing ? { methods: normalizeMethods(existing.methods) } : emptyProfile()
}

/**
 * Record that a user has completed a verification method (idempotent). The
 * CALLER is responsible for having actually verified the method — this store
 * only persists the result.
 *
 * @returns the updated profile.
 */
export function addMethod(user: string, method: VerificationMethod): VerificationProfile {
  const key = normalizeUserKey(user)
  const s = store()
  const current = s.byUser.get(key)?.methods ?? []
  const next = normalizeMethods([...current, method])
  const profile: VerificationProfile = { methods: next }
  s.byUser.set(key, profile)
  return profile
}

/** Replace a user's methods wholesale (used by tests / a re-sync). */
export function setMethods(user: string, methods: readonly unknown[]): VerificationProfile {
  const key = normalizeUserKey(user)
  const clean = normalizeMethods(
    methods.map(asVerificationMethod).filter((m): m is VerificationMethod => m !== null),
  )
  const profile: VerificationProfile = { methods: clean }
  store().byUser.set(key, profile)
  return profile
}

/* ────────────────────────────────────────────────────────────────────────────
 * AGENT-keyed profiles. Same store, same derive-everything-from-methods contract,
 * but keyed by the deterministic `agentId` instead of a user wallet — so a
 * verification (e.g. an OIDC "Sign in with Google" token that carried the agent
 * claim) can be recorded against the AGENT, making "this agent is Google-verified"
 * durably queryable on its own. An agent profile and a user profile never collide:
 * the key spaces are a 40-hex address vs a 64-hex bytes32.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Read an AGENT's verification profile (empty when the agent has verified nothing). */
export function getAgentProfile(agentId: string): VerificationProfile {
  const key = normalizeAgentKey(agentId)
  const existing = store().byAgent.get(key)
  return existing ? { methods: normalizeMethods(existing.methods) } : emptyProfile()
}

/**
 * Record that an AGENT has completed a verification method (idempotent). The CALLER
 * is responsible for having actually verified the method (e.g. a valid OIDC token
 * that carried the agent claim) — this store only persists the result.
 *
 * @returns the updated agent profile.
 */
export function addAgentMethod(agentId: string, method: VerificationMethod): VerificationProfile {
  const key = normalizeAgentKey(agentId)
  const s = store()
  const current = s.byAgent.get(key)?.methods ?? []
  const next = normalizeMethods([...current, method])
  const profile: VerificationProfile = { methods: next }
  s.byAgent.set(key, profile)
  return profile
}

/** Replace an AGENT's methods wholesale (used by tests / a re-sync). */
export function setAgentMethods(agentId: string, methods: readonly unknown[]): VerificationProfile {
  const key = normalizeAgentKey(agentId)
  const clean = normalizeMethods(
    methods.map(asVerificationMethod).filter((m): m is VerificationMethod => m !== null),
  )
  const profile: VerificationProfile = { methods: clean }
  store().byAgent.set(key, profile)
  return profile
}

/** Test-only: wipe the store (user + agent profiles). NOT used in production paths. */
export function __resetVerificationStore(): void {
  const g = globalThis as unknown as Record<string, ProfileStore | undefined>
  g[GLOBAL_KEY] = { byUser: new Map(), byAgent: new Map() }
}
