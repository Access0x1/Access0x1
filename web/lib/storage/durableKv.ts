/**
 * durableKv.ts — the generic durable key→JSON store behind every NON-security
 * data store in the rail (tenant branding, verification profiles, AI API keys,
 * the agent spend meter).
 *
 * THE PROBLEM. These stores historically pinned a `Map` on `globalThis`. That is
 * fine for one dev process, but on Cloud Run scale-to-zero (or a second instance)
 * the map EVAPORATES — a merchant's branding/checkout identity, a user's
 * verification methods, an issued API key all silently vanish. Unlike the replay
 * stores (`lib/security/replayStore.ts`) this is a DATA-DURABILITY problem, not an
 * auth-replay one: losing the data is a product bug, not a security hole.
 *
 * SO: FAIL-SOFT, NOT FAIL-CLOSED. The replay store FAILS CLOSED in production with
 * no DB (a lost nullifier ⇒ replay ⇒ it 503s). These stores must NOT 503 — losing
 * a branding row degrades UX, it does not let an attacker double-spend. When no DB
 * is configured we fall back to the in-memory map with a ONE-TIME warning, exactly
 * like dev. Configure `NULLIFIER_STORE_URL` (or `DATABASE_URL` — the SAME env the
 * durable replay store reads) to make them durable.
 *
 * THE SEAM. Each store keeps its existing SYNCHRONOUS in-memory map as the hot read
 * surface (so its exported get/set interface is UNCHANGED and no call site changes).
 * This module is a write-through + boot-hydrate side-channel:
 *   - `durableSet(ns, key, value)` mirrors a write to Postgres (best-effort; a DB
 *     error is logged, never thrown — fail-soft).
 *   - `durableDelete(ns, key)` mirrors a removal.
 *   - `hydrate(ns, apply)` loads every persisted row for a namespace back into the
 *     in-memory map at boot, so a restart restores the data the map lost.
 * When no DB is configured every call is a cheap no-op and the store is purely the
 * old in-memory behaviour.
 */

import { createPostgresKvStore } from './postgresKvStore.js'

/** The durable backend contract. Async because Postgres does real I/O. */
export interface DurableKvStore {
  /** Read one value, or `undefined` when absent. */
  get(key: string): Promise<unknown | undefined>
  /** Upsert one value (atomic per `(namespace, key)`). */
  set(key: string, value: unknown): Promise<void>
  /** Remove one key (no-op when absent). */
  delete(key: string): Promise<void>
  /** Every `(key, value)` in this namespace — used to hydrate the in-memory cache. */
  entries(): Promise<Array<[string, unknown]>>
  /**
   * OPTIONAL atomic numeric-counter ops — used ONLY by the agent spend meter, whose
   * cap is a MONEY-SAFETY invariant that a per-process (`globalThis`) counter cannot
   * hold across Cloud Run instances (each instance's in-memory ledger is empty, so a
   * plain last-write-wins `set` lets N instances each spend up to the full cap). A
   * backend that implements these enforces the cap in the DB in ONE statement, so the
   * ceiling is global. Backends that omit them signal callers to use the non-atomic
   * in-memory fallback (unchanged, per-instance) — hence optional.
   */

  /**
   * Atomically add `delta` to the counter at `key` ONLY IF the resulting total stays
   * `<= cap`, and return the NEW total; return `null` when the reservation would breach
   * the cap (nothing written). A fresh key starts at 0. Single-statement so concurrent
   * instances serialize on the row — the whole point.
   */
  reserveWithinCap?(key: string, delta: number, cap: number): Promise<number | null>
  /**
   * Atomically subtract `delta` from the counter at `key`, clamped at 0 (a refund can
   * never drive the ledger negative — law #5), and return the new total. A missing key
   * is treated as 0 (returns 0).
   */
  decrementClamped?(key: string, delta: number): Promise<number>
}

/**
 * The configured connection string, or null when neither env var is set. Reads the
 * SAME env as the durable replay store (`NULLIFIER_STORE_URL` preferred,
 * `DATABASE_URL` fallback) so one Postgres URL durably backs every store. Reading
 * the env each call keeps tests able to flip it without module-cache games.
 */
export function durableKvUrl(): string | null {
  const url =
    process.env.NULLIFIER_STORE_URL?.trim() || process.env.DATABASE_URL?.trim() || ''
  return url.length > 0 ? url : null
}

/** Is a durable KV backend CONFIGURED? True when a connection string is present. */
export function isDurableKvConfigured(): boolean {
  return durableKvUrl() !== null
}

// One backend per (namespace) per process so we don't open a fresh pool per write.
const backends = new Map<string, DurableKvStore>()

let warned = false
function warnInMemoryOnce(): void {
  if (warned) return
  warned = true
  // eslint-disable-next-line no-console
  console.warn(
    '[storage/durableKv] No durable store configured (set NULLIFIER_STORE_URL or ' +
      'DATABASE_URL) — branding / verification / API-key / meter data lives ONLY in ' +
      'memory and is LOST on restart or scale-to-zero. This is fine for dev; a real ' +
      'deployment should provision Postgres so a merchant’s identity survives.',
  )
}

/**
 * Get (or lazily build + cache) the durable backend for `namespace`, or `null`
 * when no DB is configured. Selecting the Postgres adapter does NOT load `pg`
 * (lazy import on first query), so the in-memory path never touches it.
 *
 * @param injectedBackend - test-only seam: supply a fake backend (skips Postgres).
 */
export function getDurableKv(
  namespace: string,
  injectedBackend?: DurableKvStore,
): DurableKvStore | null {
  if (injectedBackend) {
    backends.set(namespace, injectedBackend)
    return injectedBackend
  }
  // A previously-cached backend (incl. a test-injected one) wins regardless of env,
  // so write-through/hydrate use the SAME instance the caller wired. Only when none
  // is cached do we consult the env: build the Postgres adapter when a URL is set,
  // else fail-soft to in-memory (null) with a one-time warning.
  const cached = backends.get(namespace)
  if (cached) return cached
  const url = durableKvUrl()
  if (!url) {
    warnInMemoryOnce()
    return null
  }
  const backend = createPostgresKvStore(namespace, url)
  backends.set(namespace, backend)
  return backend
}

/**
 * Mirror a write to the durable backend (best-effort, fail-soft). No-op when no DB
 * is configured. A backend error is LOGGED, never thrown — durability is a nicety
 * here, not a security gate, so a transient DB hiccup must never break a write to
 * the authoritative in-memory map.
 */
export function durableSet(namespace: string, key: string, value: unknown): void {
  const backend = getDurableKv(namespace)
  if (!backend) return
  backend.set(key, value).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[storage/durableKv] set failed for ${namespace}/${key}:`, err)
  })
}

/**
 * Atomic durable spend-reservation (the agent meter's cross-instance cap). Returns:
 *   - `undefined` — NO durable atomic path (no DB, or a backend without the op, or a
 *     DB error): the caller must fall back to its in-memory per-instance ceiling. A DB
 *     error is logged and treated as "no durable path" (fail-soft — a transient DB
 *     hiccup must not brick the agent; the in-memory ceiling still bounds each instance);
 *   - `null` — durable path present and the reservation BREACHED the cap (reject);
 *   - `number` — accepted; the new authoritative cross-instance total.
 */
export async function durableReserveWithinCap(
  namespace: string,
  key: string,
  delta: number,
  cap: number,
): Promise<number | null | undefined> {
  const backend = getDurableKv(namespace)
  if (!backend || typeof backend.reserveWithinCap !== 'function') return undefined
  try {
    return await backend.reserveWithinCap(key, delta, cap)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[storage/durableKv] reserveWithinCap failed for ${namespace}/${key}:`, err)
    return undefined
  }
}

/**
 * Atomic durable refund (clamped at 0). Returns the new authoritative total, or
 * `undefined` when there is no durable atomic path (no DB / unsupported / DB error) so
 * the caller keeps its in-memory clamp. Fail-soft — a refund is never blocked (law #5).
 */
export async function durableDecrementClamped(
  namespace: string,
  key: string,
  delta: number,
): Promise<number | undefined> {
  const backend = getDurableKv(namespace)
  if (!backend || typeof backend.decrementClamped !== 'function') return undefined
  try {
    return await backend.decrementClamped(key, delta)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[storage/durableKv] decrementClamped failed for ${namespace}/${key}:`, err)
    return undefined
  }
}

/** Mirror a removal to the durable backend (best-effort, fail-soft). */
export function durableDelete(namespace: string, key: string): void {
  const backend = getDurableKv(namespace)
  if (!backend) return
  backend.delete(key).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[storage/durableKv] delete failed for ${namespace}/${key}:`, err)
  })
}

/**
 * Hydrate the in-memory cache for `namespace` from the durable backend at boot:
 * for every persisted `(key, value)` row, invoke `apply(key, value)` so the store
 * can rebuild its map (and any secondary indexes) from the durable copy. Resolves
 * to the number of rows applied (0 when no DB is configured). Fail-soft: a backend
 * error is logged and resolves to 0 — a store that cannot hydrate simply starts
 * empty (the old behaviour), it never crashes the module.
 *
 * Returns the in-flight promise so a store can `void hydrate(...)` at module load
 * and optionally `await` it where correctness allows.
 */
export async function hydrate(
  namespace: string,
  apply: (key: string, value: unknown) => void,
): Promise<number> {
  const backend = getDurableKv(namespace)
  if (!backend) return 0
  try {
    const rows = await backend.entries()
    for (const [key, value] of rows) {
      try {
        apply(key, value)
      } catch {
        // One bad row must not abort the whole hydration.
      }
    }
    return rows.length
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[storage/durableKv] hydrate failed for ${namespace}:`, err)
    return 0
  }
}

/** Test-only: drop cached backends + the warn latch so a flipped env takes effect. */
export function __resetDurableKvForTests(): void {
  backends.clear()
  warned = false
}
