#!/usr/bin/env node
/**
 * check-chain-claims.mjs — bind every HAND-WRITTEN chain count in README.md to the two
 * GENERATED tables that already carry the truth, so the prose can never drift from them.
 *
 * WHY THIS EXISTS. The mirror-status table (`sync-readme-status.mjs`) and the pre-mirror
 * address table (`gen-premirror-table.mjs`) are both derived from the committed broadcasts and
 * both CI-guarded. The COUNTS quoted in prose were not: "eleven testnets", "source-verified on
 * eight", "thirteen chains deployed in total" appeared hand-typed in three separate paragraphs
 * plus the verified table's own intro. On 2026-08-23 an explorer sweep found Avalanche Fuji
 * source-verified while all four places still called it pending, and a fifth hand-copy in a
 * different file disagreed with all of them. Nothing in CI noticed, because nothing compared
 * the sentences to the tables.
 *
 * This is the same remedy the address table already got: derive, then assert. A number stated
 * in prose must equal the number of rows that prove it.
 *
 * WHAT IT CHECKS
 *   1. every "live on N testnets" / "Deployed on N testnets"  == rows marked `✅ mirror`
 *   2. every "source-verified on N"                            == rows marked `✅ verified`
 *   3. every "N chains deployed in total"                      == all rows in the status table
 *   4. the chain names listed after "source-verified on N —"   == the verified table's own names
 *
 * Check 4 is the one that catches a silently-verified chain: the count and the list drift
 * together only by coincidence, so comparing the SET is strictly stronger than comparing N.
 *
 * NO NETWORK. It compares committed text against committed text and is safe in CI. Refreshing
 * the verified table itself from live explorers stays a deliberate, key-holding operation.
 *
 * Usage:
 *   node web/scripts/check-chain-claims.mjs           # report and exit 1 on any mismatch
 *   node web/scripts/check-chain-claims.mjs --quiet   # same, printing only failures
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const README = join(REPO_ROOT, 'README.md')

const STATUS_START = '<!-- MIRROR-STATUS:START'
const STATUS_END = '<!-- MIRROR-STATUS:END -->'
/** The header row that opens the hand-curated source-verification table. */
const VERIFIED_HEADER = '| Chain | Chain ID | `Access0x1Router` proxy — source-verified |'

/** Number words the README spells out, mapped to their value. Extend as the counts grow. */
const WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
}

/**
 * Resolve a spelled-out or digit count to a number.
 *
 * @param {string} token a word such as "eleven" or a bare numeral such as "11"
 * @returns {number|null} the value, or null when the token is not a count this guard understands
 */
function toNumber(token) {
  const key = token.toLowerCase().replace(/,/g, '')
  if (key in WORDS) return WORDS[key]
  return /^\d+$/.test(key) ? Number(key) : null
}

/**
 * Slice the generated CREATE3 mirror-status table out of the README.
 *
 * @param {string} md the full README text
 * @returns {{mirrored: number, preMirror: number, total: number}} row counts by marker
 */
function statusCounts(md) {
  const a = md.indexOf(STATUS_START)
  const b = md.indexOf(STATUS_END)
  if (a < 0 || b < 0) throw new Error('README.md is missing the MIRROR-STATUS markers.')
  const rows = md
    .slice(a, b)
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.includes('| --- |') && !l.includes('Chain ID |'))
  const mirrored = rows.filter((l) => l.includes('✅ mirror')).length
  const preMirror = rows.filter((l) => l.includes('⏳ pre-mirror')).length
  return { mirrored, preMirror, total: rows.length }
}

/**
 * Read the source-verification table: how many chains are marked verified, and which.
 *
 * @param {string} md the full README text
 * @returns {{verified: number, names: string[]}} the count and the verified chains' names
 */
function verifiedTable(md) {
  const start = md.indexOf(VERIFIED_HEADER)
  if (start < 0) throw new Error('README.md is missing the source-verified table header.')
  const lines = md.slice(start).split('\n')
  const names = []
  for (const line of lines.slice(1)) {
    if (!line.startsWith('| ')) break
    if (line.includes('| --- |')) continue
    if (!line.includes('✅ verified')) continue
    names.push(line.split('|')[1].trim())
  }
  return { verified: names.length, names }
}

/**
 * Normalise a chain name for set comparison: the prose and the table spell the same chain
 * slightly differently ("Robinhood Chain" against "Robinhood Chain Testnet", "Ethereum Sepolia"
 * against "Sepolia"), and only the meaningful difference should fail the build.
 *
 * @param {string} name a chain name from either surface
 * @returns {string} a comparable key
 */
function chainKey(name) {
  return name
    .toLowerCase()
    .replace(/\btestnet\b/g, '')
    .replace(/\bchain\b/g, '')
    .replace(/\bethereum\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Collect every prose count in the README, with the phrase that produced it.
 *
 * @param {string} md the full README text
 * @returns {Array<{kind: string, value: number, quote: string}>} one entry per claim found
 */
function proseClaims(md) {
  const found = []
  const patterns = [
    { kind: 'mirrored', re: /(?:live|Deployed) on \*{0,2}([A-Za-z0-9]+)\*{0,2} testnets/g },
    { kind: 'verified', re: /source-verified on \*{0,2}([A-Za-z0-9]+)\b/g },
    { kind: 'total', re: /([A-Za-z0-9]+) chains deployed in total/g },
  ]
  for (const { kind, re } of patterns) {
    for (const m of md.matchAll(re)) {
      const value = toNumber(m[1])
      if (value === null) continue
      found.push({ kind, value, quote: m[0] })
    }
  }
  return found
}

/**
 * Pull the chain names the README lists inline after a "source-verified on N — ..." phrase.
 *
 * @param {string} md the full README text
 * @returns {string[]|null} the listed names, or null when the README states no such list
 */
function proseVerifiedNames(md) {
  const m = md.match(/source-verified on \*{0,2}[A-Za-z0-9]+\*{0,2} — ([^*]+)\*\*/)
  if (!m) return null
  return m[1]
    .split(/,| and /)
    .map((s) => s.trim())
    .filter(Boolean)
}

function main() {
  const quiet = process.argv.includes('--quiet')
  const md = readFileSync(README, 'utf8')
  const status = statusCounts(md)
  const table = verifiedTable(md)
  const truth = { mirrored: status.mirrored, verified: table.verified, total: status.total }
  const failures = []

  for (const claim of proseClaims(md)) {
    const expected = truth[claim.kind]
    if (claim.value !== expected) {
      failures.push(
        `prose says ${claim.value} (${claim.kind}) in "${claim.quote}" — the tables prove ${expected}`,
      )
    }
  }

  const listed = proseVerifiedNames(md)
  if (listed) {
    const fromTable = new Set(table.names.map(chainKey))
    const fromProse = new Set(listed.map(chainKey))
    for (const name of listed) {
      if (!fromTable.has(chainKey(name))) {
        failures.push(`prose lists "${name}" as source-verified — the verified table does not`)
      }
    }
    for (const name of table.names) {
      if (!fromProse.has(chainKey(name))) {
        failures.push(`the verified table marks "${name}" verified — the prose list omits it`)
      }
    }
  }

  if (failures.length > 0) {
    console.error('README chain claims are stale:\n')
    for (const f of failures) console.error(`  - ${f}`)
    console.error(
      '\nThe generated MIRROR-STATUS table and the source-verified table are the truth.',
    )
    console.error('Correct the prose to match them, or re-derive the tables with `make sync`.')
    process.exit(1)
  }

  if (!quiet) {
    console.log(
      `README chain claims agree with the tables: ${truth.mirrored} mirrored, ` +
        `${truth.verified} source-verified, ${truth.total} chains total.`,
    )
  }
}

// Run only when invoked directly, so a test may import the helpers above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}

export { statusCounts, verifiedTable, proseClaims, proseVerifiedNames, chainKey, toNumber }
