#!/usr/bin/env node
/**
 * env-scaffold.mjs — write a blank, annotated slot for every registry-declared env
 * var that is MISSING from the local (gitignored) env files, so nothing needed is
 * ever undiscoverable at fill-time.
 *
 * WHY THIS EXISTS. `env:doctor` tells you WHAT is missing; this puts a slot for it
 * WHERE it belongs, with the purpose and how it travels at deploy:
 *   [secret → Secret Manager at deploy]  a real credential — vaulted, never plain env
 *   [public]                             NEXT_PUBLIC_* — inlined client-side at build
 *   [plain]                              server config — Cloud Run runtime env
 *
 * Web-tier vars go to `web/.env.local`; deploy-tier vars (envFile: '.env') go to the
 * repo-root `.env` (the file Foundry + the Makefile read). Both are gitignored.
 *
 * SAFE BY CONSTRUCTION:
 *   - never writes a VALUE — only `NAME=` slots with a comment;
 *   - never touches an existing key (present ⇒ skipped, value kept);
 *   - output files are 0600;
 *   - prints names only, never values.
 *
 * Usage:  npm run env:scaffold      # then fill values, check with npm run env:doctor
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '../..')
const REPO_ROOT = resolve(WEB_ROOT, '..')

const { INTEGRATIONS, envFileFor } = await import('../../lib/config/integrations.ts')

/** Key names already present in an env file (values never read into memory here). */
function keysIn(path) {
  if (!existsSync(path)) return new Set()
  const s = new Set()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (m) s.add(m[1])
  }
  return s
}

const targets = {
  'web/.env.local': { path: resolve(WEB_ROOT, '.env.local'), add: [] },
  '.env': { path: resolve(REPO_ROOT, '.env'), add: [] },
}
for (const t of Object.values(targets)) t.have = keysIn(t.path)

for (const integ of INTEGRATIONS) {
  const t = targets[envFileFor(integ)]
  if (!t) continue
  for (const v of integ.vars ?? []) {
    if (t.have.has(v.name)) continue
    const tag = v.name.startsWith('NEXT_PUBLIC_')
      ? 'public'
      : v.secret
        ? 'secret → Secret Manager at deploy'
        : v.hasDefault
          ? 'plain · has a default'
          : 'plain'
    t.add.push({ integ: integ.label, name: v.name, purpose: v.purpose, tag })
  }
}

const HEADER = `
# ============================================================
# Scaffolded slots (env:scaffold) — registry vars not yet present.
# Fill values here (gitignored). Secrets are vaulted to Secret Manager
# at deploy — never pasted anywhere tracked. Blank ⇒ that seam stays OFF.
# ============================================================
`

for (const [label, t] of Object.entries(targets)) {
  if (!t.add.length) {
    console.error(`${label}: nothing missing — every registry var has a slot.`)
    continue
  }
  let block = HEADER
  let lastInteg = null
  for (const row of t.add) {
    if (row.integ !== lastInteg) {
      block += `\n# ── ${row.integ} ──\n`
      lastInteg = row.integ
    }
    block += `# ${row.purpose}  [${row.tag}]\n${row.name}=\n`
  }
  if (!existsSync(t.path)) writeFileSync(t.path, block.trimStart(), { mode: 0o600 })
  else appendFileSync(t.path, block, { mode: 0o600 })
  const secrets = t.add.filter((r) => r.tag.startsWith('secret')).length
  console.error(
    `${label}: +${t.add.length} slot(s) (${secrets} secret → vault, ${t.add.length - secrets} plain/public)`,
  )
  for (const r of t.add) console.error(`  ${r.name}`)
}
console.error('\nNext: fill values, then `npm run env:doctor` to see readiness.')
