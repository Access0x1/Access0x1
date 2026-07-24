#!/usr/bin/env node
/**
 * @file sync-deployed-abis.mjs — the ABI-completeness law for DEPLOYED contracts.
 *
 * THE LAW (owner, 2026-07-12): "the ABI should never be missing from any of our
 * deployed contracts." A deployed contract with no committed ABI is unusable by a
 * fresh clone — no frontend, SDK, subgraph, or script can encode/decode it without
 * rebuilding from source. This enforces the law STRUCTURALLY (not a blocklist):
 *
 *   - The DEPLOYED SET is derived from `deployments/*.json` (every chain manifest),
 *     the union of contract types actually deployed (ERC1967Proxy excluded — a proxy
 *     shares its implementation's ABI, already covered by that impl).
 *   - Every deployed type MUST have a committed `abis/<Contract>.json` that is
 *     byte-identical to the compiled artifact's ABI (`out/<C>.sol/<C>.json` .abi).
 *
 * So: deploy a NEW contract → it appears in a manifest → the check fails until its
 * ABI is committed. Change a deployed contract's interface → the committed ABI
 * drifts from the fresh artifact → the check fails until regenerated. Nothing
 * deployed can ever be ABI-less or ABI-stale on main.
 *
 * This is COMPLEMENTARY to scripts/sync-abi.mjs, which drift-checks the curated
 * Router SUBSETS inlined in web/ + the SDK against clear-signing/abi/. This script
 * owns the FULL ABI of EVERY deployed contract.
 *
 * USAGE
 *   node scripts/sync-deployed-abis.mjs           # CHECK (CI gate): exit 1 on missing/drift/orphan
 *   node scripts/sync-deployed-abis.mjs --check    # same (explicit)
 *   node scripts/sync-deployed-abis.mjs --write     # regenerate abis/ from out/ (run after forge build)
 *
 * The check reads out/, so run `forge build` first (CI does). `--write` is the only
 * mode that touches abis/.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
// The CANONICAL, COMMITTED deployed set. `deployments/*.json` are gitignored
// (per-chain, regenerated locally), so they're ABSENT in CI — the mirror manifest
// is the committed source of what DeployAll deploys everywhere.
const MANIFEST = join(REPO_ROOT, 'script', 'mirror-manifest.json');
const DEPLOYMENTS = join(REPO_ROOT, 'deployments');
const OUT = join(REPO_ROOT, 'out');
const ABIS = join(REPO_ROOT, 'abis');

const rel = (p) => relative(REPO_ROOT, p);
const WRITE = process.argv.includes('--write');

/**
 * PREVIEW types — contracts that are BUILT + tested but NOT deployed anywhere yet.
 * They are allowed to carry a committed `abis/<Name>.json` (so the contract console
 * can surface them, flagged "built · not deployed yet") WITHOUT being flagged as an
 * orphan. Their ABI is DISPLAY-ONLY (the contract is not callable on-chain yet), so
 * unlike deployed types it is best-effort: `--write` refreshes it from out/ when the
 * artifact exists, and CHECK mode WARNS (never fails) on drift/missing-artifact — the
 * strict byte-law is reserved for deployed contracts, whose ABI must be exact for
 * on-chain encoding. Remove a name here once it deploys (it then becomes a normal
 * deployed type, byte-enforced). Keep this list tiny and honest.
 */
const PREVIEW_TYPES = ['Access0x1PaymentResolver', 'Access0x1SwapReceiptHook'];

/**
 * Every deployed contract type. Primary source is the committed
 * script/mirror-manifest.json (keys "<Name>.impl" / "<Name>.proxy" / a bare
 * "<Name>" for the Receiver), so this works in CI where deployments/ is absent.
 * Also unions any local deployments/*.json (gitignored) so a locally-deployed
 * contract not yet in the manifest is still caught.
 */
function deployedTypes() {
  const set = new Set();

  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const contracts = m.contracts ?? m;
    for (const key of Object.keys(contracts)) {
      const base = key.replace(/\.(impl|proxy)$/, '');
      if (base && base !== 'ERC1967Proxy') set.add(base);
    }
  } catch {
    /* manifest missing/corrupt — fall through to deployments/, then the empty guard */
  }

  if (existsSync(DEPLOYMENTS)) {
    for (const f of readdirSync(DEPLOYMENTS)) {
      if (!f.endsWith('.json')) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(DEPLOYMENTS, f), 'utf8'));
      } catch {
        continue;
      }
      const entries = Array.isArray(manifest) ? manifest : manifest.contracts ?? [];
      for (const e of entries) {
        const name = e?.name;
        if (name && name !== 'ERC1967Proxy') set.add(name);
      }
    }
  }
  return set;
}

/** The compiled ABI for a contract type, or null if the artifact is missing. */
function artifactAbi(name) {
  const p = join(OUT, `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) return null;
  try {
    const abi = JSON.parse(readFileSync(p, 'utf8')).abi;
    return Array.isArray(abi) ? abi : null;
  } catch {
    return null;
  }
}

/** Deterministic serialization (2-space, trailing newline) so drift is byte-exact. */
function serialize(abi) {
  return JSON.stringify(abi, null, 2) + '\n';
}

function main() {
  const types = [...deployedTypes()].sort();
  if (types.length === 0) {
    console.error(`ERROR: no deployed contract types found in ${rel(MANIFEST)} (or ${rel(DEPLOYMENTS)}/).`);
    process.exit(1);
  }

  // Guard: the check reads out/. If the artifacts aren't built, say so loudly
  // rather than reporting phantom "missing ABI" problems.
  const missingArtifacts = types.filter((t) => artifactAbi(t) === null);
  if (missingArtifacts.length) {
    console.error(
      `ERROR: no compiled artifact for ${missingArtifacts.length} deployed contract(s): ` +
        `${missingArtifacts.join(', ')}.\n  Run \`forge build\` first (out/ is gitignored).`,
    );
    process.exit(1);
  }

  if (WRITE) {
    if (!existsSync(ABIS)) mkdirSync(ABIS, { recursive: true });
    let wrote = 0;
    for (const name of types) {
      writeFileSync(join(ABIS, `${name}.json`), serialize(artifactAbi(name)));
      wrote++;
    }
    // Preview types (built, not deployed): refresh from out/ when the artifact exists;
    // leave the committed display-only ABI untouched when it doesn't (e.g. no forge here).
    let previews = 0;
    for (const name of PREVIEW_TYPES) {
      const abi = artifactAbi(name);
      if (abi) {
        writeFileSync(join(ABIS, `${name}.json`), serialize(abi));
        previews++;
      }
    }
    // Prune orphans — an ABI committed for a contract that is neither deployed nor a
    // declared preview type.
    for (const f of existsSync(ABIS) ? readdirSync(ABIS) : []) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -'.json'.length);
      if (!types.includes(name) && !PREVIEW_TYPES.includes(name)) {
        console.warn(`  (orphan) ${rel(join(ABIS, f))} — no longer deployed; remove it manually.`);
      }
    }
    console.log(`Wrote ${wrote} deployed-contract ABIs to ${rel(ABIS)}/` + (previews ? ` (+${previews} preview).` : '.'));
    return;
  }

  // CHECK mode.
  const problems = [];
  for (const name of types) {
    const file = join(ABIS, `${name}.json`);
    if (!existsSync(file)) {
      problems.push(`${name}: deployed, but ${rel(file)} is MISSING (the ABI law).`);
      continue;
    }
    const committed = readFileSync(file, 'utf8');
    const fresh = serialize(artifactAbi(name));
    if (committed !== fresh) {
      problems.push(`${name}: ${rel(file)} DRIFTED from the compiled artifact.`);
    }
  }
  // Orphan ABIs (committed but neither deployed nor a declared preview) are flagged.
  for (const f of existsSync(ABIS) ? readdirSync(ABIS) : []) {
    if (!f.endsWith('.json') || f === 'README.md') continue;
    const name = f.slice(0, -'.json'.length);
    if (!types.includes(name) && !PREVIEW_TYPES.includes(name)) {
      problems.push(`${rel(join(ABIS, f))}: committed ABI for a contract not in any deployment manifest.`);
    }
  }

  // Preview types are DISPLAY-ONLY (not deployed): drift / a missing artifact is a
  // WARNING, never a failure — the strict byte-law is only for deployed contracts.
  for (const name of PREVIEW_TYPES) {
    const file = join(ABIS, `${name}.json`);
    if (!existsSync(file)) {
      console.warn(`  (preview) ${name}: no committed ABI yet — run --write after a build to surface it.`);
      continue;
    }
    const abi = artifactAbi(name);
    if (abi && readFileSync(file, 'utf8') !== serialize(abi)) {
      console.warn(`  (preview) ${rel(file)}: display ABI drifted from the artifact — refresh with --write.`);
    }
  }

  if (problems.length) {
    console.error(`Deployed-ABI check FAILED (${problems.length} issue(s)):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\nEvery deployed contract (from deployments/*.json) must have a committed\n` +
        `abis/<Contract>.json matching its compiled artifact. Regenerate with:\n` +
        `  forge build && node scripts/sync-deployed-abis.mjs --write\n` +
        `then commit abis/.`,
    );
    process.exit(1);
  }

  console.log(`Deployed-ABI check OK — all ${types.length} deployed contracts have a current committed ABI.`);
}

main();
