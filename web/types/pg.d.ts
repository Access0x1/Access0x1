/**
 * pg.d.ts — minimal ambient declaration so the LITERAL `import('pg')` in the two
 * Postgres adapters (lib/storage/postgresKvStore.ts, lib/security/
 * postgresReplayStore.ts) typechecks WITHOUT adding a @types/pg dependency. Both
 * adapters immediately cast the import through their own minimal PgModule
 * interfaces — the only surface they use — so the `any` this grants never leaks
 * into a call site.
 *
 * The import MUST stay literal: the previous computed specifier
 * (['p','g'].join('')) existed to dodge exactly this typecheck, but it also
 * blinded Next's file tracer, so `output: standalone` shipped WITHOUT pg and
 * every production hydrate failed with "Cannot find module 'pg'" while health
 * reported postgres (the 2026-08-17 incident). A one-line ambient declaration is
 * the honest price of a traceable import.
 */
declare module 'pg'
