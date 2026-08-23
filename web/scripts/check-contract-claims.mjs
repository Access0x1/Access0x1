#!/usr/bin/env node
/**
 * check-contract-claims.mjs — bind the README's contract-surface counts to the actual contents
 * of src/, the same way check-chain-claims.mjs binds the chain counts to the deployment tables.
 *
 * WHY THIS EXISTS. On 2026-08-23 the chain counts were found drifting because five files each
 * kept a hand-typed copy. A guard fixed that class. The very next number checked by hand — the
 * contract surface — turned out to be wrong too: the README said "plus 35 interfaces" against
 * an actual 29 interface-only files, which made its own arithmetic impossible (41 + 35 = 76
 * against 70 files present). The contract counts were right; the interface count was not, and
 * nothing compared any of them to the directory they describe.
 *
 * The lesson generalises past chains: a number in prose that nothing recomputes will drift. So
 * every count describing src/ is now derived here and asserted against the sentence that
 * quotes it.
 *
 * WHAT COUNTS AS WHAT. Measured by DECLARATION, never by filename or directory, because both of
 * those lie: two files (src/Refunds.sol, src/ens/Access0x1PaymentResolver.sol) declare an
 * interface alongside their implementation, and one interface lives outside src/interfaces/.
 *
 *   production contract  a file declaring `contract ` at column 0
 *   library              a file declaring `library ` at column 0
 *   implementation file  either of the above — the "excluding interfaces" population
 *   interface-only file  a file declaring `interface ` and NO contract or library
 *
 * A file declaring both is an implementation file, counted once. That keeps the three
 * populations disjoint, so they sum to the total and the README's arithmetic can be checked.
 *
 * NO NETWORK, no compiler: it reads the .sol sources directly, so CI stays fast and
 * deterministic.
 *
 * Usage:
 *   node web/scripts/check-contract-claims.mjs           # report and exit 1 on any mismatch
 *   node web/scripts/check-contract-claims.mjs --quiet    # print only failures
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const SRC = join(REPO_ROOT, 'src')
const README = join(REPO_ROOT, 'README.md')

/** Number words the README spells out, mapped to their value. */
const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, twenty: 20, thirty: 30, forty: 40, fifty: 50,
}

/**
 * Resolve a spelled-out or digit count to a number.
 *
 * @param {string} token a word such as "two" or a numeral such as "39"
 * @returns {number|null} the value, or null when the token is not a count
 */
function toNumber(token) {
  const key = token.toLowerCase().replace(/,/g, '')
  if (key in WORDS) return WORDS[key]
  return /^\d+$/.test(key) ? Number(key) : null
}

/**
 * Every .sol path under a directory, recursively.
 *
 * @param {string} dir the directory to walk
 * @returns {string[]} absolute paths
 */
function solFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...solFiles(full))
    else if (extname(entry) === '.sol') out.push(full)
  }
  return out
}

/**
 * Count the three disjoint populations in src/ by declaration.
 *
 * @returns {{contracts: number, libraries: number, implementation: number,
 *            interfaceOnly: number, total: number}} the measured surface
 */
export function measureSurface() {
  const files = solFiles(SRC)
  let contracts = 0
  let libraries = 0
  let interfaceOnly = 0
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const hasContract = /^contract /m.test(text)
    const hasLibrary = /^library /m.test(text)
    const hasInterface = /^interface /m.test(text)
    if (hasContract) contracts += 1
    else if (hasLibrary) libraries += 1
    else if (hasInterface) interfaceOnly += 1
  }
  return {
    contracts,
    libraries,
    implementation: contracts + libraries,
    interfaceOnly,
    total: files.length,
  }
}

/**
 * Collect the README's stated surface counts, each with the phrase that produced it.
 *
 * @param {string} md the full README text
 * @returns {Array<{kind: string, value: number, quote: string}>} one entry per claim found
 */
function proseClaims(md) {
  const found = []
  const patterns = [
    { kind: 'contracts', re: /\*{0,2}([A-Za-z0-9]+) production contracts?/g },
    { kind: 'libraries', re: /production contracts? \+ ([A-Za-z0-9]+) librar/g },
    { kind: 'implementation', re: /\(([A-Za-z0-9]+) `?\.sol`? files in\s*\n?`?src\/`? excluding interfaces/g },
    { kind: 'interfaceOnly', re: /plus ([A-Za-z0-9]+) interface-only files/g },
    { kind: 'total', re: /—\s*([A-Za-z0-9]+) in `src\/` altogether/g },
  ]
  for (const { kind, re } of patterns) {
    for (const m of md.matchAll(re)) {
      const value = toNumber(m[1])
      if (value === null) continue
      found.push({ kind, value, quote: m[0].replace(/\s+/g, ' ').trim() })
    }
  }
  return found
}

function main() {
  const quiet = process.argv.includes('--quiet')
  const md = readFileSync(README, 'utf8')
  const truth = measureSurface()
  const failures = []

  const claims = proseClaims(md)
  for (const claim of claims) {
    const expected = truth[claim.kind]
    if (claim.value !== expected) {
      failures.push(
        `prose says ${claim.value} (${claim.kind}) in "${claim.quote}" — src/ has ${expected}`,
      )
    }
  }

  // The populations are disjoint by construction, so they must sum. A README that quotes three
  // of them and fails this is quoting a set that cannot exist.
  if (truth.implementation + truth.interfaceOnly !== truth.total) {
    failures.push(
      `measured populations do not sum: ${truth.implementation} implementation + ` +
        `${truth.interfaceOnly} interface-only != ${truth.total} total`,
    )
  }

  if (claims.length === 0) {
    failures.push('no contract-surface claim found in README.md — the guard has nothing to bind')
  }

  if (failures.length > 0) {
    console.error('README contract-surface claims are stale:\n')
    for (const f of failures) console.error(`  - ${f}`)
    console.error('\nsrc/ is the truth. Correct the prose to match it.')
    process.exit(1)
  }

  if (!quiet) {
    console.log(
      `README contract surface agrees with src/: ${truth.contracts} contracts + ` +
        `${truth.libraries} libraries = ${truth.implementation} implementation, ` +
        `${truth.interfaceOnly} interface-only, ${truth.total} total.`,
    )
  }
}

// Run only when invoked directly, so a test may import measureSurface.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
