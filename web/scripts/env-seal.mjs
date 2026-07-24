#!/usr/bin/env node
/**
 * env-seal.mjs — turn `.env.local` into ONE encrypted file you can carry to a
 * deploy, instead of pasting 20+ secrets into a provider console.
 *
 * WHAT THIS BUYS YOU: N secrets become 1. The sealed file travels with the
 * deploy; only the passphrase has to be supplied out of band.
 *
 * WHAT IT DOES NOT BUY YOU: the passphrase is still a secret that must reach the
 * process somehow. This reduces the problem, it does not remove it. And unlike a
 * managed store there is NO rotation, NO revocation, and NO audit log — for keys
 * guarding real money, that trail is the whole point.
 *
 * NEVER commit `.env.sealed` to a public repo. Encrypted-at-rest is not
 * encrypted-against-someone-who-has-your-file-and-time; a sealed file is an
 * offline target with no rate limit.
 *
 * USAGE
 *   npm run env:seal              # .env.local  -> .env.sealed
 *   npm run env:seal -- --open    # .env.sealed -> .env.local
 *   npm run env:seal -- --check   # verify the sealed file opens; writes nothing
 *
 * The passphrase comes from ACCESS0X1_ENV_PASSPHRASE if set, otherwise it is
 * prompted for with echo OFF.
 *
 * AT DEPLOY TIME:
 *   ACCESS0X1_ENV_PASSPHRASE=... node scripts/env-seal.mjs --open && npm start
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '..')
const PLAIN_PATH = join(WEB_ROOT, '.env.local')
const SEALED_PATH = join(WEB_ROOT, '.env.sealed')

const ARGS = process.argv.slice(2)
const MODE = ARGS.includes('--open') ? 'open' : ARGS.includes('--check') ? 'check' : 'seal'

/** Refuse to write a secrets file git would track. */
function assertGitignored(path, label) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: WEB_ROOT, stdio: 'ignore' })
  } catch {
    console.error(
      `\nREFUSING: ${label} is not gitignored.\n` +
        `Add it to .gitignore before continuing — a sealed file in a public repo is an\n` +
        `offline brute-force target, and a plaintext one is simply a leak.\n`,
    )
    process.exit(1)
  }
}

function promptSecret(question) {
  if (!process.stdin.isTTY) {
    console.error('No TTY for a hidden prompt. Set ACCESS0X1_ENV_PASSPHRASE instead.')
    process.exit(1)
  }
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const onData = (char) => {
      if (['\n', '\r', ''].includes(char.toString())) return
      process.stdout.clearLine?.(0)
      process.stdout.cursorTo?.(0)
      process.stdout.write(question)
    }
    process.stdin.on('data', onData)
    rl.question(question, (a) => {
      process.stdin.removeListener('data', onData)
      rl.close()
      process.stdout.write('\n')
      res(a)
    })
  })
}

async function getPassphrase(confirm) {
  const fromEnv = process.env.ACCESS0X1_ENV_PASSPHRASE
  if (fromEnv) return fromEnv
  const p = await promptSecret('passphrase: ')
  if (confirm) {
    const again = await promptSecret('confirm passphrase: ')
    if (p !== again) {
      console.error('passphrases did not match.')
      process.exit(1)
    }
  }
  return p
}

/** Atomic write at owner-only permissions. */
function writeSecure(path, contents) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, contents, { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

async function main() {
  const { seal, open, parseDotenv, SealedEnvError } = await import('../lib/config/sealedEnv.ts')

  if (MODE === 'seal') {
    assertGitignored(PLAIN_PATH, '.env.local')
    assertGitignored(SEALED_PATH, '.env.sealed')
    if (!existsSync(PLAIN_PATH)) {
      console.error('no web/.env.local to seal. Run `npm run env:set` first.')
      process.exit(1)
    }
    const plaintext = readFileSync(PLAIN_PATH, 'utf8')
    const count = parseDotenv(plaintext).size
    const passphrase = await getPassphrase(true)
    let sealed
    try {
      sealed = seal(plaintext, passphrase)
    } catch (err) {
      if (err instanceof SealedEnvError) {
        console.error(`\n${err.message}\n\nGenerate one:  openssl rand -base64 32\n`)
        process.exit(1)
      }
      throw err
    }
    writeSecure(SEALED_PATH, JSON.stringify(sealed, null, 2) + '\n')
    console.log(`\nSealed ${count} variable(s) -> web/.env.sealed (mode 0600).`)
    console.log('Store the passphrase in your password manager. There is NO recovery without it.')
    console.log('Do NOT commit .env.sealed to a public repo.\n')
    return
  }

  if (!existsSync(SEALED_PATH)) {
    console.error('no web/.env.sealed found.')
    process.exit(1)
  }
  const file = JSON.parse(readFileSync(SEALED_PATH, 'utf8'))
  const passphrase = await getPassphrase(false)
  let plaintext
  try {
    plaintext = open(file, passphrase)
  } catch (err) {
    console.error(`\n${err?.message ?? 'could not open the sealed file'}\n`)
    process.exit(1)
  }
  const names = [...parseDotenv(plaintext).keys()]

  if (MODE === 'check') {
    // Names only — the point of --check is to verify without writing plaintext.
    console.log(`\nOK: opens cleanly, ${names.length} variable(s): ${names.join(', ')}\n`)
    return
  }

  assertGitignored(PLAIN_PATH, '.env.local')
  if (existsSync(PLAIN_PATH)) {
    const backup = `${PLAIN_PATH}.bak`
    writeSecure(backup, readFileSync(PLAIN_PATH, 'utf8'))
    console.log(`(existing .env.local backed up to .env.local.bak)`)
  }
  writeSecure(PLAIN_PATH, plaintext)
  console.log(`\nWrote ${names.length} variable(s) -> web/.env.local (mode 0600).`)
  console.log('Verify with:  npm run env:doctor\n')
}

main().catch((err) => {
  console.error('env-seal failed:', err?.message ?? 'unknown error')
  process.exit(1)
})
