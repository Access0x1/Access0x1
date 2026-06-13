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
 *   4. `npm install` inside app/ so the Next.js checkout can build.
 *   5. `forge build` to prove the vendored contracts compile end to end.
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
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONTRACTS = join(ROOT, 'contracts');
const APP = join(ROOT, 'app');

const isWin = platform() === 'win32';

// ── tiny output helpers (no chalk dep) ───────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));
const bold = c('1');
const dim = c('2');
const green = c('32');
const yellow = c('33');
const red = c('31');

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
function run(cmd, args, cwd, label) {
  console.log(dim(`  $ ${cmd} ${args.join(' ')}  ${cwd === ROOT ? '' : `(in ${cwd.replace(ROOT, '.')})`}`));
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin });
  if (res.status !== 0) {
    throw new Error(`${label || cmd} failed (exit ${res.status ?? 'signal ' + res.signal}).`);
  }
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
  // --no-commit so it works inside any repo state; the pins in foundry.lock are honored on build.
  run('forge', ['install', 'foundry-rs/forge-std', 'OpenZeppelin/openzeppelin-contracts', '--no-commit'], CONTRACTS, 'forge install');
}

function npmInstall(dir, label) {
  heading(label);
  if (!existsSync(join(dir, 'package.json'))) {
    console.log(yellow(`  no package.json in ${dir.replace(ROOT, '.')} — skipping.`));
    return;
  }
  run('npm', ['install'], dir, `npm install (${label})`);
}

function forgeBuild() {
  heading('Compile the vendored contracts (forge build)');
  run('forge', ['build'], CONTRACTS, 'forge build');
}

async function main() {
  console.log(bold(green('\nAccess0x1 starter — toolchain setup\n')));
  console.log(dim('Bootstraps Foundry + the Solidity deps + the app deps, then compiles the contracts.'));

  ensureForge();
  installSubmodules();
  npmInstall(CONTRACTS, 'Contract deps (@chainlink/contracts)');
  npmInstall(APP, 'App deps (Next.js + @access0x1/react)');
  forgeBuild();

  console.log(green('\nSetup complete.\n'));
  console.log(bold('Next:'));
  console.log(`  ${dim('1.')} Fill ${bold('app/.env.local')} — set your router address (the no-deploy path) and the`);
  console.log(`     chain RPC / USDC slots. Every address slot is blank on purpose (LAW #4).`);
  console.log(`  ${dim('2.')} ${bold('cd app && npm run dev')}  ${dim('→ http://localhost:3000')}`);
  console.log(`  ${dim('3.')} (optional) Deploy your OWN router: see ${bold('contracts/DEPLOY.md')}.\n`);
}

main().catch((err) => {
  console.error(red('\nsetup failed:'), err && err.message ? err.message : err);
  process.exit(1);
});
