/**
 * postgresReplayStore.ts — the DURABLE, self-hostable replay store (the seam's
 * documented Postgres target; audit finding R-2).
 *
 * A single `UNIQUE(namespace, key)` table is the arbiter of "has this World ID
 * nullifier / OIDC subject been spent?". The claim is one statement:
 *
 *     INSERT INTO ax1_replay_claims (namespace, key) VALUES ($1, $2)
 *     ON CONFLICT (namespace, key) DO NOTHING
 *     RETURNING 1
 *
 * The DB UNIQUE constraint — not an app-side read-then-write — decides the winner,
 * so the claim is ATOMIC under concurrency, IDEMPOTENT, and REPLAY-PROOF across
 * process restarts (the whole point of R-2). `RETURNING 1` yields exactly one row
 * on a FRESH insert and zero rows on a CONFLICT, so `rowCount === 1` ⇔ "this call
 * won the slot".
 *
 * SELF-HOSTABLE, NOT AWS-LOCKED: plain `pg` against any Postgres URL
 * (`NULLIFIER_STORE_URL`, falling back to `DATABASE_URL`). No managed-service SDK.
 *
 * `pg` is a LAZY, OPTIONAL dependency: it is only imported when a durable store is
 * actually configured, so dev/test/in-memory paths never need it installed, and
 * the typecheck does not depend on `@types/pg` being present. The minimal client
 * shape this adapter uses is declared locally below.
 */

import type { ReplayStore } from './replayStore.js'

/** The schema this adapter owns. Idempotent — safe to run on every cold start. */
export const REPLAY_CLAIMS_DDL = `
CREATE TABLE IF NOT EXISTS ax1_replay_claims (
  namespace  TEXT        NOT NULL,
  key        TEXT        NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (namespace, key)
);
`.trim()

/**
 * The slice of the `pg` Pool API this adapter uses. Declared locally so the module
 * typechecks without `@types/pg` installed (the dependency is optional + lazy).
 */
interface PgQueryResult {
  rowCount: number | null
}
interface PgPool {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>
}
interface PgModule {
  Pool: new (config: { connectionString: string }) => PgPool
}

/**
 * Build a durable Postgres-backed replay store over `connectionString`.
 *
 * The schema is ensured ONCE per process (a memoized promise gates the first
 * claim/has on the `CREATE TABLE IF NOT EXISTS`), so an operator does not have to
 * run a migration by hand for the gate to work — though provisioning the DB
 * instance + setting the connection secret is still the operator's job.
 *
 * @param connectionString - a Postgres URL (from `NULLIFIER_STORE_URL`/`DATABASE_URL`).
 * @param injectedPool - test-only seam: supply a fake Pool to avoid a live DB.
 */
export function createPostgresReplayStore(
  connectionString: string,
  injectedPool?: PgPool,
): ReplayStore {
  let poolPromise: Promise<PgPool> | null = null
  let ddlPromise: Promise<void> | null = null

  async function pool(): Promise<PgPool> {
    if (injectedPool) return injectedPool
    if (!poolPromise) {
      poolPromise = (async () => {
        // Lazy dynamic import: `pg` is only loaded when a durable store is actually
        // configured. The specifier is computed so the typecheck does NOT depend on
        // `pg`/`@types/pg` being installed — `pg` is an OPTIONAL peer the operator
        // installs to use the durable store. Tests mock it via `vi.mock('pg')` or
        // the `injectedPool` seam, so no live DB is required.
        const specifier: string = ['p', 'g'].join('')
        const imported = (await import(/* @vite-ignore */ specifier)) as unknown as
          | PgModule
          | { default: PgModule }
        const mod: PgModule =
          'Pool' in imported ? (imported as PgModule) : (imported as { default: PgModule }).default
        return new mod.Pool({ connectionString })
      })()
    }
    return poolPromise
  }

  async function ensureSchema(): Promise<void> {
    if (!ddlPromise) {
      ddlPromise = (async () => {
        const p = await pool()
        await p.query(REPLAY_CLAIMS_DDL)
      })()
    }
    return ddlPromise
  }

  return {
    async claim(namespace: string, key: string): Promise<boolean> {
      await ensureSchema()
      const p = await pool()
      // ON CONFLICT DO NOTHING + RETURNING: one row iff THIS call inserted (won
      // the slot); zero rows on a duplicate (replay). The UNIQUE index is the
      // atomic arbiter — no read-then-write race.
      const res = await p.query(
        'INSERT INTO ax1_replay_claims (namespace, key) VALUES ($1, $2) ' +
          'ON CONFLICT (namespace, key) DO NOTHING RETURNING 1',
        [namespace, key],
      )
      return (res.rowCount ?? 0) === 1
    },

    async has(namespace: string, key: string): Promise<boolean> {
      await ensureSchema()
      const p = await pool()
      const res = await p.query(
        'SELECT 1 FROM ax1_replay_claims WHERE namespace = $1 AND key = $2 LIMIT 1',
        [namespace, key],
      )
      return (res.rowCount ?? 0) > 0
    },
  }
}
