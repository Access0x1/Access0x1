#!/usr/bin/env node
/**
 * create-access0x1 — one-command scaffolder for the whole Access0x1 stack.
 *
 * Like `create-next-app`, but for the Access0x1 non-custodial, USD-priced (Chainlink) payments
 * stack. It drops a runnable project into a target directory:
 *   - a minimal Next.js checkout wired to `@access0x1/react`'s <PayButton>,
 *   - your own BYO Foundry contracts (the real `Access0x1Router` + deploy scripts) so you can
 *     `forge script DeployAll` and own a non-custodial instance with zero dependency on us,
 *   - a one-tag embed.js, and
 *   - a `.env.example` listing EVERY integration seam as a fill-in blank.
 *
 * Doctrine / LAW #4 (truth in copy): this CLI NEVER writes an invented router/feed/USDC/contract
 * address. Every address is an env placeholder with a "confirm at booth / fill from your deploy"
 * note. The only chain values baked in are the public chain IDs (which are facts, not secrets).
 *
 * Zero runtime dependencies: only Node builtins (fs/path/url/readline) so it runs instantly straight
 * from a repo checkout. No build step — this is plain ESM (.mjs). Access0x1 is git-distributed, not
 * published to any npm registry, so this CLI is run from the repo (not via `npx create-access0x1`).
 *
 * Usage (from a checkout of the Access0x1 repo):
 *   node packages/create-access0x1/bin/index.mjs my-app --chain base --features checkout,subscriptions --yes
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, basename, sep } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

// The starter template now lives at the REPO ROOT (`templates/starter/`) so it can be fetched
// directly with `npx degit Access0x1/Access0x1/templates/starter`. This CLI is a thin, private
// convenience wrapper that copies the SAME tree (resolved relative to the package, then the repo).
// We try a couple of candidate locations so the CLI works both from a git checkout and from a
// tarball that bundles the template alongside the package.
const TEMPLATE_CANDIDATES = [
  resolve(PKG_ROOT, '..', '..', 'templates', 'starter'), // repo root: packages/create-access0x1 → ../../templates/starter
  join(PKG_ROOT, 'template'), // legacy/bundled fallback
  join(PKG_ROOT, 'templates', 'starter'), // bundled-at-package-root fallback
];
const TEMPLATE_DIR = TEMPLATE_CANDIDATES.find((p) => existsSync(p)) ?? TEMPLATE_CANDIDATES[0];

// ── tiny ANSI helpers (no chalk dep) ──────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));
const bold = c('1');
const dim = c('2');
const cyan = c('36');
const green = c('32');
const yellow = c('33');
const red = c('31');

// ── the supported chains (public chain IDs are facts — not invented addresses) ─
// Mirrors web/lib/chains.ts: arc-testnet (native-gas USDC), base-sepolia, zksync-sepolia.
const CHAINS = {
  arc: {
    key: 'arc',
    name: 'Arc Testnet',
    chainId: 5042002,
    // Env-var suffix used for NEXT_PUBLIC_ROUTER_ADDRESS_<chainId> wiring.
    routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_5042002',
    note: 'Arc — USDC IS the native gas token (verify the "no separate gas" claim end-to-end before shipping that copy).',
  },
  base: {
    key: 'base',
    name: 'Base Sepolia',
    chainId: 84532,
    routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_84532',
    note: 'Base Sepolia — standard 6-decimal Circle USDC + Chainlink feeds.',
  },
  zksync: {
    key: 'zksync',
    name: 'zkSync Sepolia',
    chainId: 300,
    routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_300',
    note: 'zkSync Sepolia — native gas is ETH; USDC + feeds are booth/docs confirms.',
  },
  // ── KNOWN, deploy PENDING — config only (chain IDs are public facts; no router until deployed) ─
  zerog: {
    key: 'zerog',
    name: '0G Galileo Testnet',
    chainId: 16602,
    routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_16602',
    note: '0G Galileo — PENDING deploy. Native gas "0G"; no Chainlink/Pyth feed → bare/adapter pricing.',
  },
  monad: {
    key: 'monad',
    name: 'Monad Testnet',
    chainId: 10143,
    routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_10143',
    note: 'Monad — PENDING deploy. Native gas "MON"; Chainlink push ETH/USD + USDC/USD feeds are live.',
  },
  bera: {
    key: 'bera',
    name: 'Berachain Bepolia',
    chainId: 80069,
    routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_80069',
    note: 'Berachain Bepolia — PENDING deploy. Native gas "BERA"; no verified feed → Pyth/adapter.',
  },
  sei: {
    key: 'sei',
    name: 'Sei Testnet (atlantic-2)',
    chainId: 1328,
    routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_1328',
    note: 'Sei atlantic-2 — PENDING deploy. Native gas "SEI"; Pyth-native → PriceOracleAdapter (Pyth).',
  },
  megaeth: {
    key: 'megaeth',
    name: 'MegaETH Testnet',
    chainId: 6342,
    routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_6342',
    note: 'MegaETH — PENDING deploy. Native gas "ETH"; no Chainlink/Pyth feed confirmed → bare/adapter.',
  },
};

const FEATURE_KEYS = ['checkout', 'subscriptions', 'bookings', 'invoices'];

// ── arg parsing ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [], chain: undefined, features: undefined, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--chain') args.chain = argv[++i];
    else if (a.startsWith('--chain=')) args.chain = a.slice('--chain='.length);
    else if (a === '--features') args.features = argv[++i];
    else if (a.startsWith('--features=')) args.features = a.slice('--features='.length);
    else if (a.startsWith('-')) {
      console.error(red(`Unknown flag: ${a}`));
      process.exit(1);
    } else args._.push(a);
  }
  return args;
}

function printHelp() {
  console.log(`
${bold('create-access0x1')} — scaffold a non-custodial, USD-priced crypto checkout + your own contracts.

${bold('Usage')} ${dim('(run from a checkout of the Access0x1 repo — git-distributed, not on npm)')}
  node packages/create-access0x1/bin/index.mjs ${cyan('<target-dir>')} ${dim('[options]')}

${bold('Options')}
  --chain <key>              Settlement chain (default: arc). Deployed: arc, base, zksync.
                             Deploy-PENDING (config only): zerog, monad, bera, sei, megaeth.
  --features <list>           Comma list of: ${FEATURE_KEYS.join(', ')} (default: checkout)
  --yes, -y                   Skip prompts, accept defaults
  --help, -h                  Show this help

${bold('Example')}
  node packages/create-access0x1/bin/index.mjs my-checkout --chain base --features checkout,invoices --yes
`);
}

// ── prompt helpers (readline; only used when not --yes) ─────────────────────────
function makePrompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a)));
  return { ask, close: () => rl.close() };
}

async function promptText(ask, label, def) {
  const suffix = def ? dim(` (${def})`) : '';
  const a = (await ask(`${cyan('?')} ${label}${suffix}: `)).trim();
  return a || def;
}

async function promptChoice(ask, label, choices, def) {
  const list = choices.map((ch) => (ch === def ? bold(ch) : ch)).join(' / ');
  while (true) {
    const a = (await ask(`${cyan('?')} ${label} [${list}]: `)).trim().toLowerCase();
    if (!a) return def;
    if (choices.includes(a)) return a;
    console.log(yellow(`  Please choose one of: ${choices.join(', ')}`));
  }
}

// ── validation ──────────────────────────────────────────────────────────────────
function sanitizeProjectName(raw) {
  // npm package name rules (loose): lowercase, no spaces, url-safe.
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'access0x1-app'
  );
}

function parseFeatures(raw) {
  if (!raw) return ['checkout'];
  const wanted = raw
    .split(',')
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);
  const bad = wanted.filter((f) => !FEATURE_KEYS.includes(f));
  if (bad.length) {
    console.error(red(`Unknown feature(s): ${bad.join(', ')}. Valid: ${FEATURE_KEYS.join(', ')}`));
    process.exit(1);
  }
  // checkout is always on (it's the base flow).
  const set = new Set(['checkout', ...wanted]);
  return FEATURE_KEYS.filter((f) => set.has(f));
}

// ── token replacement ────────────────────────────────────────────────────────────
// Files whose contents get {{TOKEN}} substitution. Everything else is copied verbatim.
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.sol',
  '.toml',
  '.txt',
  '.css',
  '.html',
  '.env',
  '.example',
  '.gitignore',
  '.npmrc',
]);

function isTextFile(p) {
  const lower = p.toLowerCase();
  if (lower.endsWith('.env.example')) return true;
  for (const ext of TEXT_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  // dotfiles with no extension we know about → treat conservatively as text.
  return !/\.[a-z0-9]+$/i.test(basename(p));
}

function applyTokens(content, tokens) {
  return content.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(tokens, name) ? String(tokens[name]) : whole,
  );
}

// Template files use their real names (.gitignore, .env.example) so degit copies them correctly.
// The RENAME_ON_COPY map is kept as an empty hook in case future template entries need aliasing.
const RENAME_ON_COPY = {};

function copyTree(srcDir, destDir, tokens) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const renamed = RENAME_ON_COPY[entry] ?? entry;
    const destPath = join(destDir, renamed);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyTree(srcPath, destPath, tokens);
    } else if (isTextFile(srcPath) || renamed === '.env.example' || renamed === '.gitignore') {
      const raw = readFileSync(srcPath, 'utf8');
      writeFileSync(destPath, applyTokens(raw, tokens), 'utf8');
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/** Find every `.env.example` under `dir` (recursively), so we can seed a sibling `.env.local`. */
function findEnvExamples(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...findEnvExamples(p));
    else if (entry === '.env.example') out.push(p);
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  console.log(`\n${bold(green('create-access0x1'))} ${dim('— non-custodial USD-priced checkout + your own contracts')}\n`);

  // Resolve target dir.
  let targetArg = args._[0];
  const interactive = !args.yes && process.stdin.isTTY;
  let prompter = interactive ? makePrompter() : null;

  if (!targetArg) {
    if (prompter) {
      targetArg = await promptText(prompter.ask, 'Project directory', 'my-access0x1-app');
    } else {
      console.error(red('Error: a target directory is required (e.g. `create-access0x1 my-app`).'));
      printHelp();
      process.exit(1);
    }
  }

  const targetDir = resolve(process.cwd(), targetArg);
  const projectName = sanitizeProjectName(basename(targetDir));

  // Chain.
  let chainKey = (args.chain || '').toLowerCase();
  if (chainKey && !CHAINS[chainKey]) {
    console.error(red(`Unknown --chain "${chainKey}". Valid: ${Object.keys(CHAINS).join(', ')}`));
    process.exit(1);
  }
  if (!chainKey) {
    chainKey = prompter
      ? await promptChoice(prompter.ask, 'Settlement chain', Object.keys(CHAINS), 'arc')
      : 'arc';
  }
  const chain = CHAINS[chainKey];

  // Features.
  let features;
  if (args.features != null) {
    features = parseFeatures(args.features);
  } else if (prompter) {
    const raw = await promptText(
      prompter.ask,
      `Features (comma list of ${FEATURE_KEYS.join(', ')})`,
      'checkout',
    );
    features = parseFeatures(raw);
  } else {
    features = ['checkout'];
  }

  if (prompter) prompter.close();

  // Guard: refuse to clobber a non-empty existing dir.
  if (existsSync(targetDir)) {
    const contents = readdirSync(targetDir).filter((f) => f !== '.git');
    if (contents.length > 0) {
      console.error(red(`\nTarget directory ${cyan(targetDir)} is not empty. Aborting.`));
      process.exit(1);
    }
  }

  // Tokens for Mustache-style replacement.
  const tokens = {
    PROJECT_NAME: projectName,
    CHAIN: chain.key,
    CHAIN_NAME: chain.name,
    CHAIN_ID: String(chain.chainId),
    ROUTER_ENV: chain.routerEnv,
    FEATURES: features.join(','),
  };

  console.log(dim('Scaffolding…'));
  console.log(`  ${dim('dir     ')} ${cyan(relative(process.cwd(), targetDir) || '.')}`);
  console.log(`  ${dim('name    ')} ${projectName}`);
  console.log(`  ${dim('chain   ')} ${chain.name} ${dim(`(id ${chain.chainId})`)}`);
  console.log(`  ${dim('features')} ${features.join(', ')}\n`);

  if (!existsSync(TEMPLATE_DIR)) {
    console.error(red(`Internal error: template directory missing at ${TEMPLATE_DIR}`));
    process.exit(1);
  }

  copyTree(TEMPLATE_DIR, targetDir, tokens);

  // Materialize .env.local from .env.example wherever the .env.example landed (the Next app dir),
  // so `npm run dev` finds the file. Values stay BLANK — the user fills them (LAW #4 / #3).
  for (const envExample of findEnvExamples(targetDir)) {
    const envLocal = join(dirname(envExample), '.env.local');
    if (!existsSync(envLocal)) copyFileSync(envExample, envLocal);
  }

  printNextSteps(targetDir, chain, features);
}

function printNextSteps(targetDir, chain, features) {
  const rel = relative(process.cwd(), targetDir) || '.';
  console.log(green('\nDone. Your Access0x1 project is ready.\n'));
  console.log(bold('Next steps:\n'));
  console.log(`  ${cyan('1.')} ${bold(`cd ${rel}`)}`);
  console.log(`     ${dim('then: npm run setup')}  ${dim('(detects/installs Foundry, installs deps, builds the contracts)')}\n`);
  console.log(`  ${cyan('2.')} ${bold('Point at a router (pick one path)')}`);
  console.log(`     ${dim('a) NO-DEPLOY (default): paste a router address you trust into .env.local — works out of the box.')}`);
  console.log(`     ${dim('b) OR deploy your OWN non-custodial contracts (zero dependency on us):')}`);
  console.log(`        ${dim('cd contracts && forge script script/DeployAll.s.sol --rpc-url <your-rpc> --account deployer --broadcast')}`);
  console.log(`        ${dim('see contracts/DEPLOY.md for the full, keystore-only runbook.')}\n`);
  console.log(`  ${cyan('3.')} ${bold('Fill the env')}`);
  console.log(`     ${dim(`edit app/.env.local — set ${chain.routerEnv}=<a router you trust, or your deployed one>`)}`);
  console.log(`     ${dim('plus the RPC / USDC / feed / Dynamic slots for')} ${chain.name}.`);
  console.log(`     ${yellow('Every address slot is blank on purpose')} ${dim('(LAW #4: confirm at booth / fill from your own deploy — never a guess).')}\n`);
  console.log(`  ${cyan('4.')} ${bold('Run it')}`);
  console.log(`     ${dim('npm run dev')}  ${dim('→ open http://localhost:3000')}\n`);
  console.log(dim(`Features enabled: ${features.join(', ')}. The embed lives at app/public/embed.js.\n`));
}

main().catch((err) => {
  console.error(red('\ncreate-access0x1 failed:'));
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
