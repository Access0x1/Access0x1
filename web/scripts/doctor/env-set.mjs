#!/usr/bin/env node
/**
 * env-set.mjs — hand the app a key, safely, in one command.
 *
 * Walks the variables an integration needs, prompts for each, and writes them to
 * `web/.env.local` (gitignored). Existing values are preserved unless you
 * deliberately replace them; pressing Enter always keeps what is already there.
 *
 * SAFETY, because this tool handles real credentials:
 *   - Secret input is read with echo OFF — the value never appears on screen,
 *     so it never lands in a screen recording, a screenshot, or a shoulder.
 *   - The value is never printed back, never logged, and never sent anywhere.
 *   - `.env.local` is written with mode 0600 (owner read/write only).
 *   - Writes are atomic (temp file + rename), so an interrupted run can't leave
 *     a half-written env file.
 *   - The file is gitignored; this script refuses to run if that ever stops
 *     being true, rather than help you stage a secret.
 *
 * NEVER paste a key into a chat window, an issue, or a commit. This script is
 * the whole intake path.
 *
 * USAGE
 *   npm run env:set                 # pick from the integrations still missing keys
 *   npm run env:set -- world-id     # go straight to one integration
 *   npm run env:set -- --list       # ids only
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '../..')
const REPO_ROOT = resolve(WEB_ROOT, '..')
/** The default target; the deploy integration overrides this to the repo-root .env. */
const ENV_PATH = join(WEB_ROOT, '.env.local')

/** Resolve an integration's repo-root-relative envFile to an absolute path. */
function envPathFor(integration) {
  const rel = integration?.envFile ?? 'web/.env.local'
  return resolve(REPO_ROOT, rel)
}

const ARGS = process.argv.slice(2)
const LIST_ONLY = ARGS.includes('--list')
const TARGET = ARGS.find((a) => !a.startsWith('-'))

/**
 * Refuse to touch a target env file unless git is genuinely ignoring it. This is
 * the guard that makes writing to the repo-root `.env` (deploy secrets) as safe as
 * writing to web/.env.local — both must be gitignored, and the tool proves it
 * before writing a single byte, rather than trusting the path.
 */
function assertGitignored(path = ENV_PATH) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: REPO_ROOT, stdio: 'ignore' })
  } catch {
    console.error(
      `\nREFUSING TO WRITE: ${path} is not gitignored.\n` +
        'Writing secrets to a tracked file risks committing them. Fix .gitignore first.\n',
    )
    process.exit(1)
  }
}

/** Parse an env file into {order, map} so a rewrite preserves layout. */
function readEnvFile(path = ENV_PATH) {
  if (!existsSync(path)) return { lines: [], map: new Map() }
  const lines = readFileSync(path, 'utf8').split('\n')
  const map = new Map()
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return
    map.set(trimmed.slice(0, eq).trim(), { index: i })
  })
  return { lines, map }
}

/** Quote only when needed, and never let a value break out of its line. */
function formatValue(value) {
  const clean = value.replace(/[\r\n]/g, '')
  return /[\s#"']/.test(clean) ? `"${clean.replace(/(["\\])/g, '\\$1')}"` : clean
}

/** Atomically write updates to `path`, preserving unrelated lines and comments. */
function writeEnvFile(updates, path = ENV_PATH) {
  const { lines, map } = readEnvFile(path)
  const out = [...lines]
  for (const [name, value] of updates) {
    const line = `${name}=${formatValue(value)}`
    const existing = map.get(name)
    if (existing) out[existing.index] = line
    else out.push(line)
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, out.join('\n') + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

/**
 * Normalize a value to the shape the CODE actually compares against, and say so.
 *
 * WHY: `AGENT_URL_ALLOWLIST` is checked as `new URL(url).origin` — scheme + host
 * only. An operator naturally pastes the page they have in the address bar
 * (`https://site.example/askme`), which can NEVER match, and the failure surfaces
 * much later as a blanket `400 url not in allowlist` with nothing pointing at the
 * cause. Accepting a value that cannot work is a bug in this tool, not operator
 * error, so it is corrected here — loudly, never silently.
 *
 * Deliberately narrow: only variables whose exact comparison shape is known are
 * touched. Everything else is stored verbatim; guessing at a value's intent is
 * how config tools start corrupting input.
 *
 * @returns {{value: string, notes: string[]}} The value to store and what to tell the operator.
 */
function normalizeValue(name, raw) {
  const notes = []
  if (name !== 'AGENT_URL_ALLOWLIST') return { value: raw, notes }

  const out = []
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    let url
    try {
      url = new URL(part)
    } catch {
      notes.push(`!  "${part}" is not a URL — the agent compares origins, so this entry can never match.`)
      notes.push(`   Expected form: https://host.example`)
      continue
    }
    if (url.origin !== part) {
      notes.push(`~  "${part}" -> "${url.origin}"  (the agent compares ORIGIN only)`)
    }
    if (url.protocol === 'http:' && url.hostname !== 'localhost') {
      notes.push(`!  "${url.origin}" is http:// — a scheme mismatch is a silent deny in production.`)
    }
    if (!out.includes(url.origin)) out.push(url.origin)
  }
  if (out.length === 0) {
    notes.push('!  No usable origin — storing blank, which means DENY-ALL.')
  }
  return { value: out.join(','), notes }
}

const rl = () => createInterface({ input: process.stdin, output: process.stdout })

/** Ask a question, echoing what is typed. */
function ask(question) {
  const i = rl()
  return new Promise((res) => i.question(question, (a) => { i.close(); res(a.trim()) }))
}

/**
 * Ask for a secret with echo OFF. Falls back to a warned visible prompt when
 * stdin is not a TTY (piped input), rather than silently echoing a key.
 */
function askSecret(question) {
  if (!process.stdin.isTTY) {
    console.log('  (stdin is not a TTY — input will be VISIBLE)')
    return ask(question)
  }
  return new Promise((res) => {
    const i = rl()
    const onData = (char) => {
      // Re-print the prompt with no characters, so nothing is ever rendered.
      if (['\n', '\r', '\u0004'].includes(char.toString())) return
      process.stdout.clearLine?.(0)
      process.stdout.cursorTo?.(0)
      process.stdout.write(question)
    }
    process.stdin.on('data', onData)
    i.question(question, (a) => {
      process.stdin.removeListener('data', onData)
      i.close()
      process.stdout.write('\n')
      res(a.trim())
    })
  })
}

/** Read a single value out of a parsed env file's line map. */
function valueFromMap(path, map, name) {
  if (!map.has(name)) return undefined
  return readFileSync(path, 'utf8').split('\n')[map.get(name).index].split('=').slice(1).join('=').trim()
}

async function main() {
  // `isPlaceholder` comes from the registry rather than being re-implemented here:
  // two copies of "what counts as unfilled" would drift, and the doctor and this
  // tool disagreeing about whether a value is real is the worst possible outcome.
  const { INTEGRATIONS, statusOf, isPlaceholder } = await import('../../lib/config/integrations.ts')

  // A value can live in web/.env.local (app) or the repo-root .env (deploy). Read
  // BOTH so the status of every integration is correct regardless of its file.
  const LOCAL_PATH = join(WEB_ROOT, '.env.local')
  const ROOT_ENV = resolve(REPO_ROOT, '.env')
  const local = readEnvFile(LOCAL_PATH)
  const root = readEnvFile(ROOT_ENV)
  const lookup = (n) => {
    if (process.env[n] !== undefined && process.env[n] !== '') return process.env[n]
    return valueFromMap(LOCAL_PATH, local.map, n) ?? valueFromMap(ROOT_ENV, root.map, n)
  }

  if (LIST_ONLY) {
    for (const i of INTEGRATIONS) console.log(`${i.id}\t${i.label}`)
    return
  }

  let chosen
  if (TARGET) {
    chosen = INTEGRATIONS.find((i) => i.id === TARGET)
    if (!chosen) {
      console.error(`unknown integration: ${TARGET}\nRun with --list to see the ids.`)
      process.exit(2)
    }
  } else {
    const pending = INTEGRATIONS.map((i) => ({ i, s: statusOf(i, lookup) })).filter((r) => !r.s.ready)
    if (!pending.length) {
      console.log('\nEverything in the registry is configured. Nothing to set.\n')
      return
    }
    console.log('\nIntegrations still missing required values:\n')
    pending.forEach(({ i, s }, n) => {
      console.log(`  ${n + 1}) ${i.label}  [${i.impact}]${s.state === 'partial' ? '  ⚠️  PARTIAL' : ''}`)
      console.log(`     ${i.unlocks}`)
    })
    const pick = await ask('\nWhich number (or blank to cancel)? ')
    if (!pick) return
    chosen = pending[Number(pick) - 1]?.i
    if (!chosen) { console.error('no such option.'); process.exit(2) }
  }

  // Write to the file this integration's consumer actually reads. The deploy
  // integration targets the repo-root .env (Foundry + Make); everything else the
  // web app's .env.local. The gitignore guard runs against THAT file before any write.
  const targetPath = envPathFor(chosen)
  const targetRel = chosen.envFile ?? 'web/.env.local'
  assertGitignored(targetPath)

  console.log(`\n── ${chosen.label}`)
  console.log(`   ${chosen.unlocks}`)
  console.log(`   Where to get it: ${chosen.where}`)
  console.log(`   Writes to: ${targetRel}\n`)

  // ONLY ASK FOR WHAT IS ACTUALLY MISSING. Walking an operator past fields they
  // already filled — each one needing an Enter to leave alone — trains them to
  // press Enter through the whole list, which is exactly how a REQUIRED field
  // gets skipped by reflex. A value that is already real is not a question.
  // `--all` revisits everything, for changing a value on purpose.
  const REVISIT_ALL = ARGS.includes('--all')
  const isReal = (name) => {
    const v = lookup(name)
    return typeof v === 'string' && v.trim() !== '' && !isPlaceholder(v)
  }
  const settled = REVISIT_ALL ? [] : chosen.vars.filter((v) => isReal(v.name))
  const toAsk = REVISIT_ALL ? chosen.vars : chosen.vars.filter((v) => !isReal(v.name))

  if (settled.length) {
    console.log(`   already set (skipping): ${settled.map((v) => v.name).join(', ')}`)
    console.log(`   to change one: npm run env:set -- ${chosen.id} --all\n`)
  }
  if (toAsk.length === 0) {
    console.log('Nothing left to fill for this integration.\n')
    return
  }

  const updates = new Map()
  for (const v of toAsk) {
    const current = lookup(v.name)
    const state = current ? 'already set' : v.required ? 'REQUIRED, not set' : 'optional, not set'
    console.log(`${v.name} — ${v.purpose}`)
    console.log(`  (${state}${v.secret ? ', secret: input hidden' : ''})`)
    // A value the operator cannot invent must say so BEFORE the cursor blinks —
    // "REQUIRED, not set" otherwise reads as an instruction to type something.
    if (v.mintedBy) console.log(`  ↳ NOT yours to choose — minted by ${v.mintedBy}`)
    const prompt = v.mintedBy && !current
      ? '  press Enter to skip (nothing to type yet): '
      : current
        ? '  new value (Enter = keep current): '
        : '  value (Enter = skip): '
    const answer = v.secret ? await askSecret(prompt) : await ask(prompt)
    if (answer) {
      const { value, notes } = normalizeValue(v.name, answer)
      for (const n of notes) console.log(`  ${n}`)
      updates.set(v.name, value)
    }
    console.log('')
  }

  if (!updates.size) {
    console.log('Nothing changed.\n')
    return
  }

  writeEnvFile(updates, targetPath)
  // Names only — printing a value here would defeat the hidden prompt.
  console.log(`Wrote ${updates.size} value(s) to ${targetRel} (mode 0600): ${[...updates.keys()].join(', ')}`)
  console.log('Verify with:  npm run env:doctor\n')
}

main().catch((err) => {
  // Never interpolate an error that could carry a value the user just typed.
  console.error('env-set failed:', err?.message ?? 'unknown error')
  process.exit(1)
})
