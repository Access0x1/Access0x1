#!/usr/bin/env node
/**
 * deploy-env.mjs — turn everything `env:set` collected into what the deploy needs.
 *
 * WHY THIS EXISTS. The deploy wired exactly ONE integration: Dynamic. Every other
 * sponsor key — Walrus/anchor, 0G, Namestone, Unlink, Claude, World's signing key,
 * the agent config, Telegram — sat filled in `web/.env.local` and was never passed to
 * the running service, so on the live site those seams were dark no matter what the
 * operator had set. `env:set` asks for all of them; the deploy ignored all but one.
 *
 * The registry (`lib/config/integrations.ts`) already knows every variable, whether it
 * is a secret, and whether it is `NEXT_PUBLIC_` (inlined into the browser at build) or
 * server-only (read at runtime). This derives the deploy inputs from THAT, so:
 *   - a new sponsor added to the registry is deployed automatically, no plumbing;
 *   - nothing is hand-listed here to drift out of sync.
 *
 * Two outputs, because the two kinds of variable reach the app by different roads:
 *   --public-out <file>   NEXT_PUBLIC_* values → a `.env.production.local` the build
 *                         inlines. These are PUBLIC (they ship in the client bundle),
 *                         so writing them to a build-context file leaks nothing.
 *   --runtime-out <file>  server values → a Cloud Run env-vars YAML, injected at
 *                         runtime, never baked into the image.
 *
 * SAFETY. The human-readable summary prints NAMES and configured/blank booleans only —
 * never a value — so it is safe on a shared terminal. Values appear only inside the two
 * output files, which the deploy script writes with tight permissions and deletes after.
 *
 * Usage (invoked by scripts/deploy-web.sh; runnable alone to preview):
 *   node web/scripts/doctor/deploy-env.mjs                    # summary only
 *   node web/scripts/doctor/deploy-env.mjs --public-out P --runtime-out R
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '../..')
const REPO_ROOT = resolve(WEB_ROOT, '..')

/** Minimal dotenv parse — KEY=value, ignoring blanks/comments, stripping matched quotes. */
function parseEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if (!val.startsWith('"') && !val.startsWith("'")) {
      const hash = val.indexOf(' #')
      if (hash >= 0) val = val.slice(0, hash).trim()
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** A value that is present but obviously scaffolding, not a real credential. */
function isPlaceholder(v) {
  if (!v) return true
  return /⟨|⟩|paste|your-|<your|changeme|example\.com|0x000000000000000000000000000000000000dead/i.test(
    v,
  )
}

async function main() {
  const { INTEGRATIONS, statusOf } = await import('../../lib/config/integrations.ts')

  // Values live in ONE of two files: web/.env.local (app) or repo-root .env (deploy
  // toolchain). Process env wins for anything an operator exported for this run.
  const local = parseEnvFile(join(WEB_ROOT, '.env.local'))
  const root = parseEnvFile(join(REPO_ROOT, '.env'))
  const lookup = (name) => {
    if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name]
    if (local[name] !== undefined && local[name] !== '') return local[name]
    return root[name]
  }

  const publicVars = {} // NEXT_PUBLIC_* → value (build-time, public)
  const plainVars = {} // non-secret server config → runtime env (safe as plain env)
  const secretVars = {} // secret:true → Secret Manager, never plain env config
  const summary = [] // per-integration, names + booleans only

  for (const integ of INTEGRATIONS) {
    const status = statusOf(integ, lookup)
    const setNames = []
    for (const v of integ.vars ?? []) {
      const val = lookup(v.name)
      if (val === undefined || val === '' || isPlaceholder(val)) continue
      setNames.push(v.name)
      // The registry's `secret` flag decides the road: a real credential goes to
      // Secret Manager (vaulted), a public id or non-sensitive setting stays a plain
      // env var. NEXT_PUBLIC_* is public by definition and never a secret.
      if (v.name.startsWith('NEXT_PUBLIC_')) publicVars[v.name] = val
      else if (v.secret) secretVars[v.name] = val
      else plainVars[v.name] = val
    }
    summary.push({
      id: integ.id,
      label: integ.label,
      impact: integ.impact,
      state: status.state,
      setCount: setNames.length,
      total: (integ.vars ?? []).length,
    })
  }

  const publicOut = argValue('--public-out')
  const runtimeOut = argValue('--runtime-out')

  if (publicOut) {
    // A .env file Next inlines at build. NEXT_PUBLIC only — safe to sit in the context.
    const body = Object.entries(publicVars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
    writeFileSync(publicOut, body + (body ? '\n' : ''), { mode: 0o600 })
  }

  if (runtimeOut) {
    // The env-vars-file carries ONLY non-secret values: the public NEXT_PUBLIC_* vars
    // (public by definition) and plain server config. Secrets are excluded on purpose —
    // they go to Secret Manager below, never into the service's plaintext env config.
    //
    // NEXT_PUBLIC vars are here as well as in the build because several are read by
    // SERVER code at runtime — `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` is what the JWT
    // verifier needs, and passing it only as a build arg is exactly the bug where
    // sign-in works and every write is rejected.
    const runtimeAll = { ...publicVars, ...plainVars }
    // Cloud Run --env-vars-file format: a flat YAML map. Values single-quoted with
    // internal quotes doubled, so commas/URLs/keys survive intact.
    const yaml = Object.entries(runtimeAll)
      .map(([k, v]) => `${k}: '${String(v).replace(/'/g, "''")}'`)
      .join('\n')
    writeFileSync(runtimeOut, yaml + (yaml ? '\n' : ''), { mode: 0o600 })
  }

  const secretsDir = argValue('--secrets-dir')
  if (secretsDir) {
    // One file per secret (the value, 0600) plus a manifest the deploy script loops:
    //   <ENV_VAR>  <secret-manager-name>
    // The Secret Manager NAME is the env var lowercased with underscores → dashes,
    // matching the convention in DEPLOY-GCP.md (env ANTHROPIC_API_KEY → secret
    // anthropic-api-key). Values NEVER touch argv or stdout — only these 0600 files,
    // which the deploy script deletes when it exits.
    mkdirSync(secretsDir, { recursive: true })
    const manifest = []
    for (const [name, val] of Object.entries(secretVars)) {
      const secretName = name.toLowerCase().replace(/_/g, '-')
      writeFileSync(join(secretsDir, `val__${name}`), String(val), { mode: 0o600 })
      manifest.push(`${name} ${secretName}`)
    }
    writeFileSync(join(secretsDir, 'manifest.txt'), manifest.join('\n') + (manifest.length ? '\n' : ''), {
      mode: 0o600,
    })
  }

  // ── Human summary: names + counts ONLY, never a value ────────────────────────
  const order = { core: 0, feature: 1, optional: 2 }
  summary.sort((a, b) => order[a.impact] - order[b.impact] || a.label.localeCompare(b.label))
  const icon = { configured: '✅', partial: '⚠️ ', off: '· ' }
  console.error('\nDeploy will wire every configured integration — not just Dynamic:\n')
  let lastImpact = null
  for (const s of summary) {
    if (s.impact !== lastImpact) {
      const head =
        s.impact === 'core' ? 'CORE' : s.impact === 'feature' ? 'FEATURES' : 'OPTIONAL'
      console.error(`  ── ${head} ──`)
      lastImpact = s.impact
    }
    const note = s.state === 'configured' ? '' : `  (${s.setCount}/${s.total} set — env:set to finish)`
    console.error(`  ${icon[s.state] ?? '· '} ${s.label}${note}`)
  }
  const pub = Object.keys(publicVars).length
  const plain = Object.keys(plainVars).length
  const sec = Object.keys(secretVars).length
  console.error(
    `\n  → ${pub} public + ${plain} plain config var(s) as env; ${sec} secret(s) to Secret Manager.` +
      '\n  Blank ones stay OFF (fail-soft). Fill any with `npm run env:set` before deploying.\n',
  )
}

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

main().catch((err) => {
  console.error('deploy-env failed:', err?.message ?? err)
  process.exit(1)
})
