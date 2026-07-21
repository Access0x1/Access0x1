/**
 * @file sync-test-badge.mjs — single source of truth + drift gate for the
 *       README test-count badge.
 *
 * WHY: the README's "Tests-<N> passing" shields badge (and the "<N> tests, all
 * green" prose) was a HAND-TYPED snapshot with no binding to the actual suite,
 * so it drifted silently — the exact "trust signal not linked to its source"
 * problem. This binds the number to `forge test --list`: the count comes from
 * the real test surface, and CI fails if the README disagrees. The claim can no
 * longer go stale without turning CI red.
 *
 * The count is the number of test CASES the suite defines (`forge test --list`);
 * the CI green/red badge above it is the live "they pass" signal, so together
 * they say "<N> tests, and they pass" without a human re-typing the number.
 *
 * Usage:
 *   node scripts/sync-test-badge.mjs          # CHECK (CI gate): exit 1 on drift
 *   node scripts/sync-test-badge.mjs --check  # same (explicit)
 *   node scripts/sync-test-badge.mjs --write  # regenerate the README number
 *
 * Mirrors the sync-abi.mjs / sync-readme-status.mjs "generate + --check" idiom.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');

/** Count every test case forge sees, deterministically, without running them. */
function forgeTestCount() {
  const out = execFileSync('forge', ['test', '--list', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  // Shape: { "<file>": { "<Contract>": ["testFoo()", ...] } }
  const data = JSON.parse(out);
  let n = 0;
  for (const contracts of Object.values(data)) {
    for (const tests of Object.values(contracts)) n += tests.length;
  }
  if (!Number.isInteger(n) || n <= 0) {
    console.error('sync-test-badge: forge test --list returned no tests — aborting.');
    process.exit(1);
  }
  return n;
}

// The two README claims this file owns. Each: [regex with (pre)(number)(post), formatter].
const CLAIMS = [
  {
    // shields badge: Tests-1989%20passing
    re: /(Tests-)(\d[\d,]*)(%20passing)/,
    format: (n) => String(n),
    label: 'badge',
  },
  {
    // prose: "make test              # 1,989 tests, all green"
    re: /(make test\s+#\s*)(\d[\d,]*)( tests, all green)/,
    format: (n) => n.toLocaleString('en-US'),
    label: 'prose count',
  },
];

const write = process.argv.includes('--write');
const count = forgeTestCount();
let readme = readFileSync(README, 'utf8');

if (write) {
  let changed = 0;
  for (const c of CLAIMS) {
    const next = readme.replace(c.re, (_m, pre, _num, post) => `${pre}${c.format(count)}${post}`);
    if (next !== readme) changed++;
    readme = next;
  }
  writeFileSync(README, readme);
  console.log(`sync-test-badge: wrote ${count} tests to README (${changed} claim(s) updated).`);
} else {
  const problems = [];
  for (const c of CLAIMS) {
    const m = readme.match(c.re);
    if (!m) {
      problems.push(`${c.label}: pattern not found in README`);
      continue;
    }
    const have = m[2].replace(/,/g, '');
    if (have !== String(count)) {
      problems.push(`${c.label}: README says ${m[2]}, forge reports ${count}`);
    }
  }
  if (problems.length) {
    console.error(
      `README test-count drift (${problems.length}):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\n\nFix: node scripts/sync-test-badge.mjs --write  (then commit the README).`,
    );
    process.exit(1);
  }
  console.log(`test-count OK — README matches forge (${count} tests).`);
}
