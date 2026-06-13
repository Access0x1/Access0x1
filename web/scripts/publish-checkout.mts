/**
 * publish-checkout.mts — publish the built checkout page (and any brand assets)
 * to Walrus, then print the blob id + the network-served URL.
 *
 * This is the operator-run step of the "Unstoppable Checkout" seam: once the
 * static checkout has been built, this pushes it to decentralized storage so
 * it cannot be taken down. It prints the blob id you then reference from the
 * shareable link / on-chain page record.
 *
 * USAGE (npm script wraps the Node type-stripping flag):
 *   npm run publish:checkout -- <file> [<file> ...]
 *   # or directly (Node 22+ strips the TS types at load):
 *   node --experimental-strip-types scripts/publish-checkout.mts <file> [...]
 *   # with explicit endpoints (e.g. self-hosted publisher / mainnet):
 *   WALRUS_PUBLISHER=https://my-publisher WALRUS_AGGREGATOR=https://my-agg \
 *     WALRUS_EPOCHS=5 npm run publish:checkout -- dist/checkout.html
 *
 * If no file argument is given it defaults to `public/embed.js` (the One-Tag
 * Checkout payload that already lives in this app), so the script is runnable
 * out of the box against testnet.
 *
 * HONEST SCOPE (law #4):
 *   - Defaults to TESTNET Walrus (best-effort, free, may be GC'd). Mainnet
 *     publishing costs WAL and needs a funded publisher — point WALRUS_PUBLISHER
 *     at it. No Sui keypair / WAL handling lives here (no secrets, law #3).
 *   - Network call lives ONLY in `main()`; the lib's encode/url helpers are pure
 *     and offline-tested. This script is not run by the gate (it needs network).
 *
 * Run with a TypeScript-aware Node loader (Node 22 strips the TS types via
 * `--experimental-strip-types`; `tsx`/`ts-node`/Bun/Deno also work). The
 * `.ts` import extension is deliberate: extensionful imports are what those
 * runtimes resolve, and `tsconfig` enables `allowImportingTsExtensions`.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { WalrusClient, WALRUS_MAINNET_NOTE } from '../lib/walrus.ts';

/** Map a file extension to a sensible Content-Type for the Walrus PUT. */
function contentTypeFor(file: string): string | undefined {
  const lower = file.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return undefined;
}

/** Read WALRUS_EPOCHS from the env as a positive integer, or undefined. */
function epochsFromEnv(): number | undefined {
  const raw = process.env.WALRUS_EPOCHS;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`WALRUS_EPOCHS must be a positive integer, got "${raw}"`);
  }
  return n;
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    // Default target: the One-Tag Checkout payload shipped in this app.
    files.push('public/embed.js');
  }

  const publisher = process.env.WALRUS_PUBLISHER;
  const aggregator = process.env.WALRUS_AGGREGATOR;
  const epochs = epochsFromEnv();

  const client = new WalrusClient({ publisher, aggregator, epochs });

  if (publisher && !/walrus-testnet/.test(publisher)) {
    console.error(`note: ${WALRUS_MAINNET_NOTE}`);
  }

  console.error(
    `Publishing ${files.length} file(s) to Walrus ` +
      `(${publisher ?? 'testnet publisher'})...`,
  );

  for (const file of files) {
    const bytes = await readFile(file);
    const result = await client.publish(
      new Uint8Array(bytes),
      contentTypeFor(file),
    );
    const url = client.urlFor(result.blobId);
    // Human-readable status to stderr; the machine-parseable line to stdout.
    console.error(
      `  ${basename(file)} -> ` +
        `${result.newlyCreated ? 'newly created' : 'already certified'}` +
        (result.endEpoch ? ` (through epoch ${result.endEpoch})` : ''),
    );
    console.log(`${result.blobId}\t${url}\t${file}`);
  }
}

main().catch((err: unknown) => {
  console.error('publish-checkout: failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
