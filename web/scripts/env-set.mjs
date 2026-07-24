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
const WEB_ROOT = resolve(HERE, '..')
const ENV_PATH = join(WEB_ROOT, '.env.local')

const ARGS = process.argv.slice(2)
const LIST_ONLY = ARGS.includes('--list')
const TARGET = ARGS.find((a) => !a.startsWith('-'))

/** Refuse to touch .env.local unless git is genuinely ignoring it. */
function assertGitignored() {
  try {
    execFileSync('git', ['check-ignore', '-q', ENV_PATH], { cwd: WEB_ROOT, stdio: 'ignore' })
  } catch {
    console.error(
      '\nREFUSING TO WRITE: web/.env.local is not gitignored.\n' +
        'Writing secrets to a tracked file risks committing them. Fix .gitignore first.\n',
    )
    process.exit(1)
  }
}

/** Parse `.env.local` into {order, map} so a rewrite preserves layout. */
function readEnvFile() {
  if (!existsSync(ENV_PATH)) return { lines: [], map: new Map() }
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n')
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

/** Atomically write updates, preserving unrelated lines and comments. */
function writeEnvFile(updates) {
  const { lines, map } = readEnvFile()
  const out = [...lines]
  for (const [name, value] of updates) {
    const line = `${name}=${formatValue(value)}`
    const existing = map.get(name)
    if (existing) out[existing.index] = line
    else out.push(line)
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  const tmp = `${ENV_PATH}.tmp`
  writeFileSync(tmp, out.join('\n') + '\n', { mode: 0o600 })
  renameSync(tmp, ENV_PATH)
  chmodSync(ENV_PATH, 0o600)
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

async function main() {
  assertGitignored()
  const { INTEGRATIONS, statusOf } = await import('../lib/config/integrations.ts')

  const { map } = readEnvFile()
  const lookup = (n) =>
    process.env[n] !== undefined && process.env[n] !== '' ? process.env[n] : (
      map.has(n) ? readFileSync(ENV_PATH, 'utf8').split('\n')[map.get(n).index].split('=').slice(1).join('=').trim() : undefined
    )

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

  console.log(`\n── ${chosen.label}`)
  console.log(`   ${chosen.unlocks}`)
  console.log(`   Where to get it: ${chosen.where}\n`)

  const updates = new Map()
  for (const v of chosen.vars) {
    const current = lookup(v.name)
    const state = current ? 'already set' : v.required ? 'REQUIRED, not set' : 'optional, not set'
    console.log(`${v.name} — ${v.purpose}`)
    console.log(`  (${state}${v.secret ? ', secret: input hidden' : ''})`)
    const prompt = current ? '  new value (Enter = keep current): ' : '  value (Enter = skip): '
    const answer = v.secret ? await askSecret(prompt) : await ask(prompt)
    if (answer) updates.set(v.name, answer)
    console.log('')
  }

  if (!updates.size) {
    console.log('Nothing changed.\n')
    return
  }

  writeEnvFile(updates)
  // Names only — printing a value here would defeat the hidden prompt.
  console.log(`Wrote ${updates.size} value(s) to web/.env.local (mode 0600): ${[...updates.keys()].join(', ')}`)
  console.log('Verify with:  npm run env:doctor\n')
}

main().catch((err) => {
  // Never interpolate an error that could carry a value the user just typed.
  console.error('env-set failed:', err?.message ?? 'unknown error')
  process.exit(1)
})
