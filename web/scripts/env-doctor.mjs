#!/usr/bin/env node
/**
 * env-doctor.mjs — "what do I still need to fill in?"
 *
 * Reads `.env.local` (and the process env) and prints, per integration, whether it
 * is CONFIGURED / PARTIAL / OFF, plus the exact variable names still missing and
 * where to get each credential. Everything is derived from lib/config/integrations
 * — adding a new API there makes it show up here automatically.
 *
 * SAFETY: this NEVER prints a secret value. It prints variable NAMES and set/unset
 * booleans only, so its output is safe to paste into a chat, an issue, or a log.
 *
 * USAGE
 *   node scripts/env-doctor.mjs              # full report
 *   node scripts/env-doctor.mjs --demo       # only what the live demo needs
 *   node scripts/env-doctor.mjs --json       # machine-readable (no values)
 *   node scripts/env-doctor.mjs --strict     # exit 1 if any `demo` integration isn't ready
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '..')

const ARGS = process.argv.slice(2)
const JSON_OUT = ARGS.includes('--json')
const DEMO_ONLY = ARGS.includes('--demo')
const STRICT = ARGS.includes('--strict')

/**
 * Parse a dotenv file into a plain object. Deliberately minimal: `KEY=value`,
 * ignoring blank lines, `#` comments, and stripping matched surrounding quotes.
 * Values are held in memory only to test emptiness — never printed.
 */
function parseEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    // Strip an inline comment on an unquoted value (mirrors .env.example style).
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const ICON = { configured: '✅', partial: '⚠️ ', off: '·  ' }
const IMPACT_ORDER = { demo: 0, feature: 1, optional: 2 }

async function main() {
  // The registry is TypeScript; read it through the same tsx/ts path the app uses.
  // Importing the .ts directly keeps ONE source of truth (no duplicated table).
  const mod = await import('../lib/config/integrations.ts')
  const { INTEGRATIONS, statusOf } = mod

  const fileEnv = parseEnvFile(join(WEB_ROOT, '.env.local'))
  const lookup = (name) =>
    process.env[name] !== undefined && process.env[name] !== ''
      ? process.env[name]
      : fileEnv[name]

  let list = INTEGRATIONS.map((i) => ({ integration: i, status: statusOf(i, lookup) }))
  if (DEMO_ONLY) list = list.filter((r) => r.integration.impact === 'demo')
  list.sort(
    (a, b) =>
      IMPACT_ORDER[a.integration.impact] - IMPACT_ORDER[b.integration.impact] ||
      a.integration.label.localeCompare(b.integration.label),
  )

  if (JSON_OUT) {
    console.log(JSON.stringify(list.map((r) => r.status), null, 2))
  } else {
    const envPath = join(WEB_ROOT, '.env.local')
    console.log(`\nAccess0x1 env doctor — ${existsSync(envPath) ? 'reading web/.env.local' : 'NO web/.env.local found (using process env)'}`)
    console.log('(names + set/unset only — no secret value is ever printed)\n')

    let lastImpact = null
    for (const { integration, status } of list) {
      if (integration.impact !== lastImpact) {
        const head =
          integration.impact === 'demo'
            ? 'NEEDED FOR THE LIVE DEMO'
            : integration.impact === 'feature'
              ? 'FEATURES (app is fine without)'
              : 'OPTIONAL'
        console.log(`── ${head} ${'─'.repeat(Math.max(0, 52 - head.length))}`)
        lastImpact = integration.impact
      }
      console.log(`${ICON[status.state]} ${integration.label}`)
      if (status.state !== 'configured') {
        console.log(`     ${integration.unlocks}`)
        if (status.placeholders?.length) {
          // The nastiest state: the file LOOKS filled in, so nobody revisits it
          // until a live call 401s. Say it before anything else.
          console.log(`     ⛔ STILL A PLACEHOLDER (not a real value): ${status.placeholders.join(', ')}`)
        }
        if (status.missingRequired.length) {
          console.log(`     MISSING: ${status.missingRequired.join(', ')}`)
        }
        if (status.state === 'partial') {
          console.log(`     ⚠️  partially set — it will stay OFF until the missing vars above are filled.`)
        }
        console.log(`     get it: ${integration.where}`)
      } else if (status.missingOptional.length) {
        // Configured, but an optional var (often the API KEY itself) is blank. Say so:
        // a green check over a call that will 401 is exactly the overclaim we forbid.
        console.log(`     not set (optional): ${status.missingOptional.join(', ')}`)
        console.log(`     ↳ if the endpoint requires a key, this will fail at call time — ${integration.where}`)
      }
      console.log('')
    }

    const demo = list.filter((r) => r.integration.impact === 'demo')
    const ready = demo.filter((r) => r.status.ready).length
    console.log(`Demo readiness: ${ready}/${demo.length} integrations configured.`)
    console.log(`Fill values in web/.env.local (gitignored). Never commit a key.\n`)
  }

  if (STRICT) {
    const blocked = list.filter((r) => r.integration.impact === 'demo' && !r.status.ready)
    if (blocked.length) {
      console.error(`env-doctor --strict: ${blocked.length} demo integration(s) not ready.`)
      process.exit(1)
    }
  }
}

main().catch((err) => {
  console.error('env-doctor failed:', err?.message ?? err)
  process.exit(1)
})
