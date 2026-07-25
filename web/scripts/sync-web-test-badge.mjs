#!/usr/bin/env node
/**
 * sync-web-test-badge.mjs — single source of truth + drift gate for the "N web/SDK unit
 * tests" claim, the sibling of `scripts/sync-test-badge.mjs` for the Foundry count.
 *
 * WHY: the Foundry number has been CI-bound to `forge test --list` for a while and has
 * stayed correct. The web number never got the same treatment, so it was hand-typed in two
 * files and drifted — an audit found it claiming 1,797 against an actual 1,816. A trust
 * signal with no binding to its source is the exact failure the Foundry script was written
 * to end; this closes the other half.
 *
 * The count comes from `vitest list`, which enumerates test CASES without running them, so
 * this is fast and deterministic. Integration tests are excluded to match the suite the
 * claim describes (`npm run gate`).
 *
 * Usage:
 *   node web/scripts/sync-web-test-badge.mjs          # CHECK (CI gate): exit 1 on drift
 *   node web/scripts/sync-web-test-badge.mjs --check  # same (explicit)
 *   node web/scripts/sync-web-test-badge.mjs --write  # rewrite the claims
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(WEB_ROOT, '..')

/**
 * Every claim of the web test count, as a regex with the number in group 1. A claim that
 * is not listed here is NOT gated — add it when you write it, or it will drift.
 */
const CLAIMS = [
  {
    file: join(REPO_ROOT, 'README.md'),
    re: /plus ([\d,]+) web\/SDK unit tests/g,
  },
  {
    file: join(REPO_ROOT, 'AUDIT.md'),
    re: /\+ ([\d,]+) web\/SDK unit tests/g,
  },
]

/** Count the test cases vitest sees, deterministically, without running them. */
function webTestCount() {
  const out = execFileSync(
    process.execPath,
    [
      join(WEB_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'list',
      '--json',
      '--exclude',
      '**/*.integration.test.ts',
    ],
    { cwd: WEB_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  const cases = JSON.parse(out)
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error('sync-web-test-badge: vitest list returned no tests — aborting.')
    process.exit(1)
  }
  return cases.length
}

/** `1816` → `1,816`, matching how the numbers are already written in prose. */
const group = (n) => n.toLocaleString('en-US')

function main() {
  const write = process.argv.includes('--write')
  const count = webTestCount()
  const want = group(count)

  let drifted = false
  for (const { file, re } of CLAIMS) {
    const before = readFileSync(file, 'utf8')
    let found = false
    const after = before.replace(re, (whole, current) => {
      found = true
      if (current === want) return whole
      drifted = true
      return whole.replace(current, want)
    })
    if (!found) {
      console.error(`sync-web-test-badge: no claim matched in ${file} — the pattern moved.`)
      process.exit(1)
    }
    if (after !== before && write) writeFileSync(file, after)
  }

  if (!drifted) {
    console.log(`sync-web-test-badge: ${want} web tests — claims in sync.`)
    return
  }
  if (write) {
    console.log(`sync-web-test-badge: claims rewritten to ${want} web tests.`)
    return
  }
  console.error(
    `sync-web-test-badge: DRIFT — the suite defines ${want} tests, the claims say otherwise.\n` +
      '  Run `node web/scripts/sync-web-test-badge.mjs --write` and commit the result.',
  )
  process.exit(1)
}

main()
