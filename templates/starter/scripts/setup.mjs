#!/usr/bin/env node
/**
 * setup.mjs — one-command toolchain bootstrap for a scaffolded Access0x1 starter.
 *
 * Run with `npm run setup` from the project root. It is idempotent and safe to re-run:
 *
 *   1. Detect Foundry (`forge`). If missing, install it via the official `foundryup` installer
 *      (curl | bash from getfoundry.sh, then run `foundryup`). On Windows this step is skipped with
 *      a printed instruction, since foundryup is a POSIX shell installer.
 *   2. `forge install` the Solidity submodules (forge-std + openzeppelin-contracts) into contracts/lib.
 *   3. `npm install` inside contracts/ so Foundry can resolve the `@chainlink/contracts` remapping
 *      (chainlink-brownie-contracts is deprecated — the npm package is the canonical source).
 *   4. Ensure `@access0x1/react` is available: Access0x1 is distributed from GitHub, not any npm
 *      registry, so this packs it from the local Access0x1 repo checkout (via `npm pack`) and wires a
 *      `file:` reference into app/package.json. A vendor/ directory at the project root holds the tarball.
 *   5. `npm install` inside app/ so the Next.js checkout can build.
 *   6. `forge build` to prove the vendored contracts compile end to end.
 *
 * Zero npm dependencies — only Node builtins (child_process / fs / path / os) so it runs the moment
 * you have Node, before anything else is installed.
 *
 * Doctrine: this script installs TOOLING only. It never writes a contract address, never deploys, and
 * never touches .env.local — those stay blank until YOU fill them (LAW #3 / #4). The generated app
 * runs against a router you configure in .env.local (the no-deploy path), so it boots out of the box
 * once you paste a router address you trust; deploying your own is the optional advanced path.
 */

import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONTRACTS = join(ROOT, 'contracts');
const APP = join(ROOT, 'app');
const VENDOR = join(ROOT, 'vendor');

const isWin = platform() === 'win32';

// ── tiny output helpers (no chalk dep) ───────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c('1');
const dim = c('2');
const green = c('32');
const yellow = c('33');
const red = c('31');
const cyan = c('36');

let step = 0;
function heading(msg) {
  step += 1;
  console.log(`\n${bold(green(`[${step}]`))} ${bold(msg)}`);
}

/** Is a binary on PATH? */
function has(bin) {
  const probe = isWin ? `where ${bin}` : `command -v ${bin}`;
  try {
    execSync(probe, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run a command in `cwd`, inheriting stdio; throw (with a clear message) on non-zero exit. */
function run(cmd, args, cwd, label, env) {
  console.log(dim(`  $ ${cmd} ${args.join(' ')}  ${cwd === ROOT ? '' : `(in ${cwd.replace(ROOT, '.')})`}`));
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: isWin,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (res.status !== 0) {
    throw new Error(`${label || cmd} failed (exit ${res.status ?? 'signal ' + res.signal}).`);
  }
}

/** Run a command silently; return { ok, stdout, stderr }. */
function runQuiet(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd: cwd || ROOT, stdio: 'pipe', shell: isWin });
  return {
    ok: res.status === 0,
    stdout: res.stdout ? res.stdout.toString().trim() : '',
    stderr: res.stderr ? res.stderr.toString().trim() : '',
  };
}

function ensureForge() {
  heading('Foundry toolchain');
  if (has('forge')) {
    console.log(`  ${green('✓')} forge already installed.`);
    return;
  }
  if (isWin) {
    console.log(
      yellow(
        '  forge not found. Foundry is a POSIX installer — install it from https://getfoundry.sh\n' +
          '  (or use WSL), then re-run `npm run setup`.',
      ),
    );
    throw new Error('Foundry not installed (Windows: install manually, then re-run).');
  }
  console.log(dim('  forge not found — installing Foundry via the official foundryup installer…'));
  // The two-step official install: fetch foundryup, then run it to download the toolchain.
  run('bash', ['-c', 'curl -L https://foundry.paradigm.xyz | bash'], ROOT, 'foundryup install');
  // foundryup lands in ~/.foundry/bin; run it from there even if PATH isn't refreshed in this shell.
  const foundryup = join(process.env.HOME || '', '.foundry', 'bin', 'foundryup');
  const foundryupCmd = existsSync(foundryup) ? foundryup : 'foundryup';
  run('bash', ['-c', foundryupCmd], ROOT, 'foundryup');
  if (!has('forge') && !existsSync(join(process.env.HOME || '', '.foundry', 'bin', 'forge'))) {
    throw new Error(
      'Foundry installed but `forge` is still not on PATH. Open a new shell (or `source ~/.bashrc`) ' +
        'so ~/.foundry/bin is on PATH, then re-run `npm run setup`.',
    );
  }
  console.log(`  ${green('✓')} Foundry installed. If forge is not found below, open a new shell and re-run.`);
}

function installSubmodules() {
  heading('Solidity submodules (forge-std + openzeppelin-contracts)');
  if (existsSync(join(CONTRACTS, 'lib', 'forge-std')) && existsSync(join(CONTRACTS, 'lib', 'openzeppelin-contracts'))) {
    console.log(`  ${green('✓')} lib/forge-std and lib/openzeppelin-contracts already present.`);
    return;
  }
  // `degit` copies the template without initializing a git repository, so `forge install` (which
  // uses git submodules by default) would fail with "not a git repository". We use --no-git to
  // clone the deps as plain directories instead. If this dir IS inside a git repo (e.g. a dev
  // working on the monorepo), --no-git is still safe — it just skips registering submodules.
  run(
    'forge',
    ['install', 'foundry-rs/forge-std', 'OpenZeppelin/openzeppelin-contracts', '--no-git'],
    CONTRACTS,
    'forge install',
  );
}

function npmInstall(dir, label, env) {
  heading(label);
  if (!existsSync(join(dir, 'package.json'))) {
    console.log(yellow(`  no package.json in ${dir.replace(ROOT, '.')} — skipping.`));
    return;
  }
  run('npm', ['install'], dir, `npm install (${label})`, env);
}

/**
 * Wire @access0x1/react from the local Access0x1 repo (Access0x1 is distributed from GitHub,
 * not any npm registry). Finds the local repo (walks up from this file, then checks known
 * sibling paths), packs a tarball with `npm pack`, stashes it in vendor/, and rewrites
 * app/package.json to use a `file:` reference. This keeps `npm run setup` self-contained
 * without ever touching a registry.
 */
function ensureAccess0x1React() {
  heading('@access0x1/react — locate or pack');

  // Fast path: already wired as file: in app/package.json (idempotent re-run).
  const appPkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
  const currentRef = appPkg.dependencies?.['@access0x1/react'] ?? '';
  if (currentRef.startsWith('file:')) {
    const tgzPath = resolve(APP, currentRef.slice('file:'.length));
    if (existsSync(tgzPath)) {
      console.log(`  ${green('✓')} @access0x1/react already wired as local tarball: ${cyan(currentRef)}`);
      return;
    }
  }

  console.log(dim('  Access0x1 is git-distributed (no npm registry) — locating the local repo to pack it…'));

  // Candidate locations for the packages/react directory — relative to THIS script
  // only (no hardcoded user-specific path). When the starter lives inside an
  // Access0x1 checkout (templates/starter/scripts/), packages/react sits a couple
  // levels up. We never guess a machine-specific clone location; if it isn't found
  // relative to here, we fail with copy-paste instructions (below) so the path the
  // user provides is explicit, not assumed.
  // Override: set ACCESS0X1_REPO to the repo root (the dir containing packages/react)
  // to point setup at a checkout in any location.
  const repoEnv = process.env.ACCESS0X1_REPO;
  const candidates = [
    ...(repoEnv ? [join(repoEnv, 'packages', 'react')] : []),
    // From the templates/starter location in a git checkout:
    resolve(__dirname, '..', '..', '..', '..', 'packages', 'react'), // templates/starter → repo root → packages/react
    resolve(__dirname, '..', '..', '..', 'packages', 'react'),       // one level shallower
  ];

  const pkgDir = candidates.find(
    (p) => existsSync(join(p, 'package.json')) && existsSync(join(p, 'src')),
  );

  if (!pkgDir) {
    console.error(red('\n  Could not locate the @access0x1/react source directory.'));
    console.error(dim('  Access0x1 is git-distributed (no npm registry) and no local checkout was found'));
    console.error(dim('  relative to this script. Choose one:'));
    console.error(dim('    a) Point setup at your Access0x1 checkout (the dir containing packages/):'));
    console.error(dim('         ACCESS0X1_REPO=/path/to/Access0x1 npm run setup'));
    console.error(dim('    b) Or build the tarball manually:'));
    console.error(dim('         cd /path/to/Access0x1/packages/react && npm ci && npm run build && npm pack'));
    console.error(dim('       Copy the resulting .tgz into vendor/ here, then run:'));
    console.error(dim('         npm --prefix app install --save @access0x1/react@file:../vendor/<tarball>.tgz'));
    throw new Error('@access0x1/react local source not found — see instructions above.');
  }

  console.log(dim(`  Found source at: ${pkgDir}`));

  // Build it if dist/ doesn't exist yet.
  if (!existsSync(join(pkgDir, 'dist'))) {
    console.log(dim('  dist/ missing — building @access0x1/react…'));
    run('npm', ['ci'], pkgDir, 'npm ci (react SDK)');
    run('npm', ['run', 'build'], pkgDir, 'npm run build (react SDK)');
  } else {
    console.log(dim('  dist/ present — skipping rebuild.'));
  }

  // Pack into vendor/.
  mkdirSync(VENDOR, { recursive: true });
  console.log(dim(`  packing @access0x1/react into vendor/…`));
  const packResult = runQuiet('npm', ['pack', '--pack-destination', VENDOR], pkgDir);
  if (!packResult.ok) {
    throw new Error(`npm pack failed:\n${packResult.stderr}`);
  }
  // npm pack outputs the filename on stdout (e.g. "access0x1-react-0.1.0.tgz").
  const tgzFilename = packResult.stdout.split('\n').pop().trim();
  const tgzPath = join(VENDOR, tgzFilename);
  console.log(`  ${green('✓')} packed → ${cyan('vendor/' + tgzFilename)}`);

  // Rewrite app/package.json to use a file: reference (relative to the app/ dir).
  const fileRef = `file:../vendor/${tgzFilename}`;
  appPkg.dependencies['@access0x1/react'] = fileRef;
  writeFileSync(join(APP, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n', 'utf8');
  console.log(`  ${green('✓')} app/package.json updated: @access0x1/react → ${cyan(fileRef)}`);
}

function forgeBuild() {
  heading('Compile the vendored contracts (forge build)');
  run('forge', ['build'], CONTRACTS, 'forge build');
}

/** Materialize app/.env.local from app/.env.example if not already present. Values stay blank. */
function seedEnvLocal() {
  heading('Seed app/.env.local');
  const envExample = join(APP, '.env.example');
  const envLocal = join(APP, '.env.local');
  if (!existsSync(envExample)) {
    console.log(yellow('  app/.env.example not found — skipping .env.local seed.'));
    return;
  }
  if (existsSync(envLocal)) {
    console.log(`  ${green('✓')} app/.env.local already exists — not overwriting.`);
    return;
  }
  copyFileSync(envExample, envLocal);
  console.log(`  ${green('✓')} Created app/.env.local from app/.env.example (values are blank — fill them in).`);
}

async function main() {
  console.log(bold(green('\nAccess0x1 starter — toolchain setup\n')));
  console.log(dim('Bootstraps Foundry + the Solidity deps + the app deps, then compiles the contracts.'));

  ensureForge();
  installSubmodules();
  npmInstall(CONTRACTS, 'Contract deps (@chainlink/contracts)');
  ensureAccess0x1React();
  // Skip the app's preinstall guard here: setup is the sanctioned path — it has
  // just resolved @access0x1/react (wired as a local file: tarball), so the
  // "run setup first" guard would be a false positive on this very install.
  npmInstall(APP, 'App deps (Next.js + @access0x1/react)', {
    ACCESS0X1_SKIP_PREINSTALL_CHECK: '1',
  });
  forgeBuild();
  seedEnvLocal();

  console.log(green('\nSetup complete.\n'));
  console.log(bold('Next:'));
  console.log(`  ${dim('1.')} Fill ${bold('app/.env.local')} — set your router address (the no-deploy path) and the`);
  console.log(`     chain RPC / USDC slots. Every address slot is blank on purpose (LAW #4).`);
  console.log(`  ${dim('2.')} ${bold('npm run dev')}  ${dim('→ http://localhost:3000')}`);
  console.log(`  ${dim('3.')} (optional) Deploy your OWN router: see ${bold('contracts/DEPLOY.md')}.\n`);
}

main().catch((err) => {
  console.error(red('\nsetup failed:'), err && err.message ? err.message : err);
  process.exit(1);
});
