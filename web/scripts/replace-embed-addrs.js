#!/usr/bin/env node
/**
 * replace-embed-addrs.js — prebuild step for the One-Tag Checkout embed.
 *
 * Reads `web/public/embed.js`, replaces each `__PLACEHOLDER__` address token
 * with the value of its corresponding `NEXT_PUBLIC_*` env var, and writes the
 * result back in place. Runs as the `prebuild` hook so `next build` always
 * ships an embed.js with real, booth-confirmed addresses.
 *
 * DOCTRINE: no address is hardcoded here — every value comes from an env var
 * (SPEC.md + CHAINS.md placeholder law). A placeholder whose env var is unset
 * is LEFT IN PLACE: the embed treats a remaining placeholder as "not deployed
 * yet" and falls back to the USD-only button label. That means the build never
 * fails just because a chain has not been deployed; it only warns.
 *
 * Usage:
 *   node scripts/replace-embed-addrs.js            # in-place edit of public/embed.js
 *   node scripts/replace-embed-addrs.js --check    # exit 1 if any placeholder remains
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Placeholder token -> NEXT_PUBLIC_* env var name. MUST stay in sync with the
 * `CHAIN_DEFAULTS` map in public/embed.js and EMBED_ADDRESS_PLACEHOLDERS in
 * lib/embedConfig.ts. Keeping all three aligned is the whole point of this map.
 */
const PLACEHOLDERS = {
  __ROUTER_ADDRESS__: 'NEXT_PUBLIC_ROUTER_ARC',
  __ARC_USDC_ADDRESS__: 'NEXT_PUBLIC_USDC_ARC',
  __BASE_SEPOLIA_ROUTER_ADDRESS__: 'NEXT_PUBLIC_ROUTER_BASE_SEPOLIA',
  __BASE_SEPOLIA_USDC_ADDRESS__: 'NEXT_PUBLIC_USDC_BASE_SEPOLIA',
  __ZKSYNC_SEPOLIA_ROUTER_ADDRESS__: 'NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA',
  __ZKSYNC_SEPOLIA_USDC_ADDRESS__: 'NEXT_PUBLIC_USDC_ZKSYNC_SEPOLIA',
};

/** Basic 0x + 40 hex sanity check so a typo'd env var can't poison the embed. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Replace placeholder tokens in `source` from `env`. Skips (leaves intact) any
 * placeholder whose env var is unset; throws on a set-but-malformed address.
 *
 * @param {string} source - the embed.js contents.
 * @param {Record<string,string|undefined>} env - the environment to read from.
 * @returns {{output: string, replaced: string[], skipped: string[]}}
 */
function replaceAddresses(source, env) {
  let output = source;
  const replaced = [];
  const skipped = [];
  for (const [token, varName] of Object.entries(PLACEHOLDERS)) {
    const value = env[varName];
    if (!value) {
      skipped.push(token);
      continue;
    }
    if (!ADDRESS_RE.test(value)) {
      throw new Error(
        `${varName} is set but not a valid 0x address: "${value}"`,
      );
    }
    output = output.split(token).join(value);
    replaced.push(token);
  }
  return { output, replaced, skipped };
}

/**
 * CLI entry: rewrite public/embed.js in place (or, with --check, verify no
 * placeholder remains and exit non-zero if one does).
 *
 * @returns {void}
 */
function main() {
  const embedPath = path.join(__dirname, '..', 'public', 'embed.js');
  const checkOnly = process.argv.includes('--check');
  const source = fs.readFileSync(embedPath, 'utf8');

  if (checkOnly) {
    const remaining = Object.keys(PLACEHOLDERS).filter((t) =>
      source.includes(t),
    );
    if (remaining.length) {
      console.error(
        '[access0x1] embed.js still has placeholders: ' + remaining.join(', '),
      );
      process.exit(1);
    }
    console.log('[access0x1] embed.js has no remaining address placeholders.');
    return;
  }

  const { output, replaced, skipped } = replaceAddresses(source, process.env);
  fs.writeFileSync(embedPath, output);
  console.log(
    '[access0x1] embed.js addresses replaced: ' +
      (replaced.length ? replaced.join(', ') : '(none)'),
  );
  if (skipped.length) {
    console.warn(
      '[access0x1] embed.js placeholders left (env unset, USD-only fallback): ' +
        skipped.join(', '),
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = { replaceAddresses, PLACEHOLDERS };
