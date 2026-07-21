#!/usr/bin/env node
/**
 * @file proxy-of.mjs — print a module's proxy address from the committed mirror manifest.
 *
 * The mirror addresses are cross-chain-IDENTICAL (CREATE3), so ONE lookup serves every chain. Used by
 * the Makefile `upgrade-*` targets so the operator only sets MODULE; override anytime with PROXY=0x...
 *
 *   node script/proxy-of.mjs Access0x1Escrow   ->  0x3459E890516A29d406fCbDc9B4CD99CE8114Da0D
 *
 * Exit 1 (with a stderr message, nothing on stdout) if the module has no `.proxy` in the manifest —
 * e.g. ChainRegistry is deployed separately and is absent; pass PROXY=0x... explicitly for those.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const module = process.argv[2];
if (!module) {
  process.stderr.write('usage: node script/proxy-of.mjs <ModuleName>\n');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(here, 'mirror-manifest.json'), 'utf8'));
const addr = manifest.contracts?.[`${module}.proxy`];
if (!addr) {
  process.stderr.write(
    `proxy-of: no "${module}.proxy" in script/mirror-manifest.json. ` +
      `Check the name, or pass PROXY=0x... explicitly (e.g. ChainRegistry is not in the mirror manifest).\n`
  );
  process.exit(1);
}
process.stdout.write(addr);
