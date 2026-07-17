/**
 * postgresKvStore.ts — the DURABLE, self-hostable key→JSON store (the data-
 * durability sibling of `lib/security/postgresReplayStore.ts`; audit finding the
 * NON-security stores still evaporate on Cloud Run scale-to-zero).
 *
 * Where the replay store is a `UNIQUE(namespace, key)` claim REGISTRY (a key is
 * present or not), this is a key→VALUE store: each row carries a JSON blob (a
 * tenant's branding, a user's verification methods, an API-key binding, a spend
 * meter). One `ax1_kv_store` table, namespaced, holds every non-security store:
 *
 *     INSERT INTO ax1_kv_store (namespace, key, value) VALUES ($1, $2, $3)
 *     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value,
 *       updated_at = now()
 *
 * The UNIQUE(namespace, key) constraint makes the upsert atomic + idempotent, and
 * the row SURVIVES a process restart — which is the whole point (a merchant's
 * identity must not vanish when the server scales to zero).
 *
 * SELF-HOSTABLE, NOT AWS-LOCKED: plain `pg` against any Postgres URL
 * (`NULLIFIER_STORE_URL`, falling back to `DATABASE_URL` — the SAME env the
 * durable replay store reads, so one connection string serves both).
 *
 * `pg` is a LAZY, OPTIONAL dependency: it is only imported when a durable store is
 * actually configured, so dev/test/in-memory paths never need it installed, and
 * the typecheck does not depend on `@types/pg` being present. The minimal client
 * shape this adapter uses is declared locally below (mirrors the replay adapter).
 */

import type { DurableKvStore } from './durableKv.js'

/** The schema this adapter owns. Idempotent — safe to run on every cold start. */
export const KV_STORE_DDL = `
CREATE TABLE IF NOT EXISTS ax1_kv_store (
  namespace  TEXT        NOT NULL,
  key        TEXT        NOT NULL,
  value      JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (namespace, key)
);
`.trim()

/**
 * The slice of the `pg` Pool API this adapter uses. Declared locally so the module
 * typechecks without `@types/pg` installed (the dependency is optional + lazy).
 */
/**
 * A returned row. An open column map because the adapter runs queries with different
 * projections: `SELECT key, value` (KV reads) and `RETURNING … AS spent` (the atomic
 * counter ops). Callers read the columns they expect with a local cast.
 */
type PgRow = Record<string, unknown>
interface PgQueryResult {
  rowCount: number | null
  rows: PgRow[]
}
interface PgPool {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>
}
interface PgModule {
  Pool: new (config: { connectionString: string }) => PgPool
}

/**
 * Build a durable Postgres-backed KV store over `connectionString`. Every method
 * is scoped to `namespace`, so many logical stores (branding, verification, …)
 * share the one `ax1_kv_store` table without colliding.
 *
 * The schema is ensured ONCE per process (a memoized promise gates the first call
 * on `CREATE TABLE IF NOT EXISTS`), so an operator does not have to run a migration
 * by hand — though provisioning the DB + setting the connection secret is still
 * their job.
 *
 * @param namespace - the logical store this instance serves (e.g. `branding:tenant`).
 * @param connectionString - a Postgres URL (from `NULLIFIER_STORE_URL`/`DATABASE_URL`).
 * @param injectedPool - test-only seam: supply a fake Pool to avoid a live DB.
 */
export function createPostgresKvStore(
  namespace: string,
  connectionString: string,
  injectedPool?: PgPool,
): DurableKvStore {
  let poolPromise: Promise<PgPool> | null = null
  let ddlPromise: Promise<void> | null = null

  async function pool(): Promise<PgPool> {
    if (injectedPool) return injectedPool
    if (!poolPromise) {
      poolPromise = (async () => {
        // Lazy dynamic import: `pg` is only loaded when a durable store is actually
        // configured. The specifier is computed so the typecheck does NOT depend on
        // `pg`/`@types/pg` being installed — `pg` is an OPTIONAL peer the operator
        // installs to use the durable store. Tests use the `injectedPool` seam, so
        // no live DB is required.
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
        await p.query(KV_STORE_DDL)
      })()
    }
    return ddlPromise
  }

  return {
    async get(key: string): Promise<unknown | undefined> {
      await ensureSchema()
      const p = await pool()
      const res = await p.query(
        'SELECT value FROM ax1_kv_store WHERE namespace = $1 AND key = $2 LIMIT 1',
        [namespace, key],
      )
      const row = res.rows[0]
      return row ? row.value : undefined
    },

    async set(key: string, value: unknown): Promise<void> {
      await ensureSchema()
      const p = await pool()
      await p.query(
        'INSERT INTO ax1_kv_store (namespace, key, value) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        [namespace, key, JSON.stringify(value)],
      )
    },

    async delete(key: string): Promise<void> {
      await ensureSchema()
      const p = await pool()
      await p.query('DELETE FROM ax1_kv_store WHERE namespace = $1 AND key = $2', [namespace, key])
    },

    async entries(): Promise<Array<[string, unknown]>> {
      await ensureSchema()
      const p = await pool()
      const res = await p.query('SELECT key, value FROM ax1_kv_store WHERE namespace = $1', [
        namespace,
      ])
      return res.rows.map((r) => [r.key, r.value] as [string, unknown])
    },

    /**
     * Atomic reserve-within-cap in ONE statement. The `INSERT … SELECT … WHERE
     * $3 <= $4` gates the FRESH-row case (a single charge above the cap inserts
     * nothing); the `ON CONFLICT DO UPDATE … WHERE current + $3 <= $4` gates the
     * EXISTING-row case (a charge that would breach the running cap updates
     * nothing). Either rejection yields zero returned rows, so `rowCount === 0`
     * means "rejected". Because it is one statement against a `UNIQUE(namespace,
     * key)` row, concurrent instances serialize on it — no lost-update window.
     */
    async reserveWithinCap(key: string, delta: number, cap: number): Promise<number | null> {
      await ensureSchema()
      const p = await pool()
      const res = await p.query(
        '/* reserveWithinCap */ ' +
          'INSERT INTO ax1_kv_store (namespace, key, value) ' +
          "SELECT $1, $2, jsonb_build_object('dayKey', $2::text, 'spent', $3::numeric) " +
          'WHERE $3::numeric <= $4::numeric ' +
          'ON CONFLICT (namespace, key) DO UPDATE SET ' +
          "  value = jsonb_set(ax1_kv_store.value, '{spent}', " +
          "    to_jsonb(COALESCE((ax1_kv_store.value->>'spent')::numeric, 0) + $3::numeric)), " +
          '  updated_at = now() ' +
          "WHERE COALESCE((ax1_kv_store.value->>'spent')::numeric, 0) + $3::numeric <= $4::numeric " +
          "RETURNING (value->>'spent')::numeric::float8 AS spent",
        [namespace, key, delta, cap],
      )
      const row = res.rows[0] as { spent?: unknown } | undefined
      if (!row) return null
      return Number(row.spent)
    },

    /**
     * Atomic refund: subtract `delta`, clamped at 0 (a refund never drives the ledger
     * negative — law #5), returning the new total. A missing row returns 0.
     */
    async decrementClamped(key: string, delta: number): Promise<number> {
      await ensureSchema()
      const p = await pool()
      const res = await p.query(
        '/* decrementClamped */ ' +
          'UPDATE ax1_kv_store SET ' +
          "  value = jsonb_set(value, '{spent}', " +
          "    to_jsonb(GREATEST(0, COALESCE((value->>'spent')::numeric, 0) - $3::numeric))), " +
          '  updated_at = now() ' +
          'WHERE namespace = $1 AND key = $2 ' +
          "RETURNING (value->>'spent')::numeric::float8 AS spent",
        [namespace, key, delta],
      )
      const row = res.rows[0] as { spent?: unknown } | undefined
      return row ? Number(row.spent) : 0
    },
  }
}
