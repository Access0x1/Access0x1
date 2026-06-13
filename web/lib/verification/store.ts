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
  byUser: Map<string, VerificationProfile>
}

/** Pin ONE store on globalThis so dev hot-reload / route instances share it. */
const GLOBAL_KEY = '__ax1_verification_store__'

function store(): ProfileStore {
  const g = globalThis as unknown as Record<string, ProfileStore | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { byUser: new Map() }
  return g[GLOBAL_KEY] as ProfileStore
}

/** Normalize a user key to a stable lowercased wallet address, or throw. */
export function normalizeUserKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('verification: user key is required')
  const id = raw.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(id)) throw new Error('verification: user key must be a wallet address')
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

/** Test-only: wipe the store. NOT used in production paths. */
export function __resetVerificationStore(): void {
  const g = globalThis as unknown as Record<string, ProfileStore | undefined>
  g[GLOBAL_KEY] = { byUser: new Map() }
}
