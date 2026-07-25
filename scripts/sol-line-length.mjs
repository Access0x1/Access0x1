#!/usr/bin/env node
/**
 * sol-line-length.mjs — catch the one `forge fmt` slip you can catch WITHOUT Foundry.
 *
 * WHY THIS EXISTS. `forge fmt --check` is a CI gate, and it runs BEFORE `forge build`, so a
 * formatting slip fails the whole contracts lane before the compiler ever sees the change —
 * you learn nothing about whether your code is even valid. On a machine without Foundry
 * `make fmt` dies at exit 127, so there is no local formatter at all and the slip is
 * invisible until CI says so. That happened twice in a row here, both times one rule: a
 * line over `line_length`.
 *
 * WHAT THIS IS NOT. It is not a reimplementation of `forge fmt`. Attempting one produced 116
 * false positives on a tree that fmt passes clean — fmt tolerates plenty of lines a naive
 * width check flags, and a linter that cries wolf is a linter everyone learns to ignore.
 *
 * SO IT IS DIFF-SCOPED. It measures only the lines a change ADDS, against the same
 * `line_length` fmt uses. Legacy lines fmt already accepts are none of its business, and a
 * newly written over-long line — the exact thing that broke CI twice — is caught before the
 * push. `forge fmt --check` remains the authority and still runs in CI.
 *
 * `line_length` is read from foundry.toml. One source of truth, never a second constant.
 *
 * Usage:
 *   node scripts/sol-line-length.mjs               # added lines vs origin/main + working tree
 *   node scripts/sol-line-length.mjs <git-ref>     # added lines vs an explicit base
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The formatter's own configured width — never a hardcoded second copy. */
function lineLength() {
  const toml = readFileSync(join(ROOT, 'foundry.toml'), 'utf8')
  const m = /^\s*line_length\s*=\s*(\d+)/m.exec(toml)
  if (!m) {
    console.error('sol-line-length: no line_length in foundry.toml — nothing to enforce.')
    process.exit(1)
  }
  return Number(m[1])
}

const MAX = lineLength()

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * Pick the base to diff against: an explicit ref, else the merge-base with origin/main, else
 * HEAD. Falling back to HEAD still covers the common case — uncommitted work in progress.
 */
function baseRef(explicit) {
  if (explicit) return explicit
  for (const candidate of ['origin/main', 'main']) {
    try {
      return git(['merge-base', 'HEAD', candidate]).trim()
    } catch {
      /* not present in this clone — try the next */
    }
  }
  return 'HEAD'
}

/**
 * Added `.sol` lines in the diff, as `{file, line, text}`. Parses the unified diff directly so
 * line NUMBERS are real and clickable, rather than reporting a bare offending string.
 */
function addedSolLines(base) {
  let diff
  try {
    diff = git(['diff', '--unified=0', base, '--', '*.sol'])
  } catch {
    console.error(`sol-line-length: could not diff against ${base} — skipping.`)
    process.exit(0)
  }
  const out = []
  let file = null
  let lineNo = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      lineNo = Number(hunk[1])
      continue
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ file, line: lineNo, text: raw.slice(1) })
      lineNo++
    }
  }
  return out
}

/** `forge fmt` never re-flows prose, so a long comment is not a violation. */
function isComment(text) {
  const t = text.trim()
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')
}

function main() {
  const base = baseRef(process.argv[2])
  const added = addedSolLines(base)
  const violations = added.filter((l) => !isComment(l.text) && l.text.length > MAX)

  if (violations.length === 0) {
    console.log(
      `sol-line-length: ${added.length} added .sol line(s) vs ${base.slice(0, 8)}, ` +
        `none over ${MAX}.`,
    )
    return
  }

  console.error(
    `sol-line-length: ${violations.length} NEW line(s) exceed line_length = ${MAX}.\n` +
      '  `forge fmt --check` runs before `forge build` in CI, so these fail the contracts\n' +
      '  lane before the compiler sees your change. Wrap them, or run `make fmt` where\n' +
      '  Foundry is installed.\n',
  )
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  (${v.text.length} chars)`)
    console.error(`    ${v.text.trim().slice(0, 96)}${v.text.trim().length > 96 ? '…' : ''}`)
  }
  process.exit(1)
}

main()
