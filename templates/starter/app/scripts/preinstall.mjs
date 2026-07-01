#!/usr/bin/env node
/**
 * preinstall.mjs — guard `npm install` in app/ so it fails with a CLEAR instruction
 * instead of a confusing registry E404.
 *
 * WHY: `@access0x1/react` is distributed from GitHub, not any npm registry. The starter's
 * app/package.json carries a placeholder version range (`^0.1.0`) that
 * `npm run setup` rewrites to a local `file:../vendor/<tarball>.tgz` reference
 * (it packs the SDK from your Access0x1 checkout). If you run `cd app && npm install`
 * BEFORE `npm run setup`, npm tries to fetch `@access0x1/react@^0.1.0` from the
 * registry and dies with a 404 that doesn't explain what to do.
 *
 * This guard runs first (npm's `preinstall` lifecycle). It allows the install when
 * the SDK is already wired locally — a `file:` reference — or when explicitly told
 * to skip (the setup script sets ACCESS0X1_SKIP_PREINSTALL_CHECK while it installs).
 * Otherwise it prints the one thing to do and exits non-zero, so the failure is the
 * instruction, not a stack trace.
 *
 * Zero dependencies (Node builtins only) — it must run before anything is installed.
 * If you instead wire `@access0x1/react` as a git dependency
 * (`github:Access0x1/Access0x1#main`), that is a valid non-registry ref too, so add a
 * `github:`/`git+`-prefix allowance below (or just remove this guard and the
 * `preinstall` entry).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Escape hatch: the setup script sets this while it runs the app install (by then
// the ref is already a file:, but this makes the intent explicit and future-proof).
if (process.env.ACCESS0X1_SKIP_PREINSTALL_CHECK) process.exit(0);

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

let ref = '';
try {
  const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'));
  ref = pkg.dependencies?.['@access0x1/react'] ?? '';
} catch {
  // No package.json / unreadable: let npm surface its own error normally.
  process.exit(0);
}

// Already wired to the local tarball that `npm run setup` produced → install is fine.
if (ref.startsWith('file:') || ref.startsWith('link:') || ref.startsWith('workspace:')) {
  process.exit(0);
}

// Otherwise the SDK has not been resolved locally yet. Fail with the fix, not a 404.
const RED = process.stdout.isTTY ? '\x1b[31m' : '';
const BOLD = process.stdout.isTTY ? '\x1b[1m' : '';
const DIM = process.stdout.isTTY ? '\x1b[2m' : '';
const OFF = process.stdout.isTTY ? '\x1b[0m' : '';

console.error(
  `\n${RED}${BOLD}@access0x1/react is git-distributed (not on npm) — run setup first.${OFF}\n` +
    `\nThe starter pins a placeholder ${BOLD}@access0x1/react@${ref || '^0.1.0'}${OFF} that ` +
    `${BOLD}npm run setup${OFF}\nrewrites to a local tarball it packs from your Access0x1 checkout.\n` +
    `\n${BOLD}From the project root, run:${OFF}\n` +
    `    npm run setup\n` +
    `\n${DIM}(setup installs the toolchain, packs @access0x1/react into vendor/, wires the\n` +
    ` file: reference into app/package.json, then installs the app deps for you.)${OFF}\n`,
);

process.exit(1);
