/**
 * replayStore.ts — the durable one-shot registry behind every replay-class
 * security gate (World ID nullifiers, OIDC subjects).
 *
 * THE PROBLEM (audit finding R-2). The sibling stores
 * (`lib/worldid/nullifierStore.ts`, `lib/oidc/subjectStore.ts`) historically
 * pinned a `Set` on `globalThis`. That is fine for a single dev process, but a
 * process restart (or a second serverless instance) DROPS every claimed key — so
 * a World ID proof or an OIDC token that was already spent can be replayed,
 * double-verifying a human / farming "Verified" badges on mainnet.
 *
 * THE SEAM. Each of those modules documented its `claim`/`has` pair as the seam a
 * real `UNIQUE(namespace, key)` table swaps behind with zero call-site changes.
 * This file is that durable target — a generic, namespaced replay store:
 *
 *     claim(namespace, key) -> true  when THIS call won the slot (first use)
 *                              false when the slot was already taken (replay)
 *
 * The claim is ATOMIC (the DB UNIQUE constraint is the arbiter, not a read-then-
 * write race), IDEMPOTENT, and survives restarts. `(namespace, key)` carries the
 * full composite identity — e.g. namespace `worldid:<action>` + the decimal
 * nullifier, or `oidc:<issuer>` + the subject — so one table serves every gate.
 *
 * ADAPTERS (selected by `getReplayStore()` from env):
 *   - Postgres (`postgresReplayStore.ts`) — the durable, self-hostable default.
 *   - In-memory (`memoryReplayStore.ts`) — a DEV-ONLY convenience.
 * The interface stays open for a future on-chain adapter: add a branch in the
 * factory; nothing at the call sites changes.
 *
 * FAIL-CLOSED. In production (NODE_ENV=production, or VERIFY_REQUIRE_DURABLE_STORE
 * =true) with no durable store configured, the factory THROWS — the verification
 * path fails closed (the route maps it to 503) rather than silently falling back
 * to the replay-vulnerable in-memory store on mainnet.
 */

/**
 * The durable replay-store contract every adapter implements. Async because the
 * durable (Postgres / future on-chain) adapters do real I/O; the in-memory dev
 * adapter just resolves immediately.
 */
import { createPostgresReplayStore } from './postgresReplayStore.js'
import { createMemoryReplayStore } from './memoryReplayStore.js'

export interface ReplayStore {
  /**
   * Atomically claim `(namespace, key)`. Returns true when THIS call won the slot
   * for the first time (allow), false when it was already taken (replay → the
   * route returns 409). Atomic + idempotent + durable across restarts.
   */
  claim(namespace: string, key: string): Promise<boolean>
  /** Read-only: has `(namespace, key)` already been claimed? Does NOT claim. */
  has(namespace: string, key: string): Promise<boolean>
}

/** Thrown by the factory when production is configured but no durable store is. */
export class DurableStoreRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DurableStoreRequiredError'
  }
}

/**
 * Is a durable replay store CONFIGURED? True when a connection string is present
 * (`NULLIFIER_STORE_URL` preferred, `DATABASE_URL` as a fallback). Reading the env
 * each call keeps tests able to flip it without module-cache games.
 */
export function isDurableStoreConfigured(): boolean {
  return replayStoreUrl() !== null
}

/** The configured connection string, or null when neither env var is set. */
export function replayStoreUrl(): string | null {
  const url =
    process.env.NULLIFIER_STORE_URL?.trim() || process.env.DATABASE_URL?.trim() || ''
  return url.length > 0 ? url : null
}

/**
 * Does the runtime DEMAND a durable store? True in production, or when an operator
 * sets `VERIFY_REQUIRE_DURABLE_STORE=true` explicitly (e.g. a staging deploy that
 * must behave like prod). When true and nothing durable is configured, the factory
 * fails closed instead of using the in-memory store.
 */
export function durableStoreRequired(): boolean {
  if (process.env.VERIFY_REQUIRE_DURABLE_STORE?.trim().toLowerCase() === 'true') return true
  return process.env.NODE_ENV === 'production'
}

// Cache ONE store per process so we don't open a fresh pool/connection per claim.
// Keyed by nothing — the env-derived choice is stable for a process lifetime; the
// reset hook below clears it for tests that flip env between cases.
let cached: ReplayStore | null = null

/**
 * Pick the replay-store adapter from env.
 *
 *  - A connection string is set  → the durable Postgres adapter (always preferred).
 *  - Nothing configured + production / VERIFY_REQUIRE_DURABLE_STORE → THROW
 *    (`DurableStoreRequiredError`); the verification route maps this to 503 so
 *    mainnet can never silently use the replay-vulnerable in-memory store.
 *  - Nothing configured + dev → the in-memory adapter with a LOUD one-time warning.
 *
 * @throws {DurableStoreRequiredError} in production/required mode with no durable store.
 */
export function getReplayStore(): ReplayStore {
  if (cached) return cached

  if (isDurableStoreConfigured()) {
    // The Postgres adapter does NOT import `pg` until its first query — so merely
    // selecting it here is cheap, and dev/test/in-memory paths never load `pg`.
    cached = createPostgresReplayStore(replayStoreUrl() as string)
    return cached
  }

  if (durableStoreRequired()) {
    throw new DurableStoreRequiredError(
      'No durable replay store is configured (set NULLIFIER_STORE_URL or DATABASE_URL). ' +
        'Refusing the in-memory store in production — it loses claimed nullifiers/subjects ' +
        'on restart, which would allow replay / double-verification. Provision a Postgres ' +
        'instance and set the connection secret before serving mainnet traffic.',
    )
  }

  // Dev-only fallback. Loud, because shipping this to prod is the R-2 bug itself.
  warnInMemoryOnce()
  cached = createMemoryReplayStore()
  return cached
}

let warned = false
function warnInMemoryOnce(): void {
  if (warned) return
  warned = true
  console.warn(
    '[security/replayStore] Using the IN-MEMORY replay store (dev only). Claimed World ID ' +
      'nullifiers / OIDC subjects are LOST on restart — replay is possible. Set ' +
      'NULLIFIER_STORE_URL (or DATABASE_URL) for a durable Postgres store. Production ' +
      'refuses this fallback and fails closed.',
  )
}

/** Test-only: drop the cached store + warn latch so a flipped env takes effect. */
export function __resetReplayStoreForTests(): void {
  cached = null
  warned = false
}
