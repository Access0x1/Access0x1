#!/usr/bin/env node
/**
 * @file sync-abi.mjs — single source of truth + drift check for the Router ABI.
 *
 * PROBLEM this solves: the Access0x1Router ABI is duplicated by hand across three
 * places that publish independently with no build-time link:
 *   1. the forge artifact               → `clear-signing/abi/Access0x1Router.abi.json`  (SOURCE OF TRUTH)
 *   2. the web app's inlined fragments   → `web/lib/contracts.ts`         (`ROUTER_ABI`)
 *   3. the React SDK's inlined fragments → `packages/react/src/abi.ts`     (`ROUTER_ABI`)
 *
 * (2) and (3) are deliberately CURATED SUBSETS of (1) — only the functions, events,
 * and custom errors each consumer actually calls or decodes. This script does NOT
 * rewrite them (their subset shape is intentional). Instead it asserts every fragment
 * they DO declare is byte-identical to the same fragment in the canonical artifact —
 * so a hand-edit that drifts from the on-chain ABI (a renamed param, a changed type, a
 * flipped `indexed`, a wrong `stateMutability`) fails CI instead of shipping a decoder
 * that silently mis-reads receipts.
 *
 * Canonical fragments are matched to consumer fragments by (type, name); overloads
 * (same name, different inputs) are matched by full signature. Comparison ignores the
 * artifact-only `internalType` field (viem never needs it and the consumers omit it)
 * but is otherwise exact on name, type, stateMutability, indexed, and input/output
 * names + types + order.
 *
 * USAGE
 *   node scripts/sync-abi.mjs            # check mode: exit 1 on any drift (CI gate)
 *   node scripts/sync-abi.mjs --check    # same (explicit)
 *
 * There is intentionally no "write"/codegen mode: the subsets are authored by hand so
 * unrelated router changes never churn these files. Regenerate the CANONICAL artifact
 * with `forge inspect Access0x1Router abi > clear-signing/abi/Access0x1Router.abi.json`
 * whenever the contract changes, then run this check and hand-apply any needed fragment
 * edits to the two consumers.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const CANONICAL = join(REPO_ROOT, 'clear-signing', 'abi', 'Access0x1Router.abi.json');
const CONSUMERS = [
  { file: join(REPO_ROOT, 'web', 'lib', 'contracts.ts'), symbol: 'ROUTER_ABI' },
  { file: join(REPO_ROOT, 'packages', 'react', 'src', 'abi.ts'), symbol: 'ROUTER_ABI' },
];

const rel = (p) => relative(REPO_ROOT, p);

/**
 * Extract `export const <symbol> = [ ... ] as const` from a TS source file and evaluate
 * it to a plain JS array. The array body is pure object/array literal syntax (JS-valid,
 * comments allowed), so we slice the balanced brackets and eval it. No TS type syntax
 * lives inside the literal, so no transpile step is needed.
 */
function extractAbi(source, symbol, file) {
  const marker = new RegExp(`export\\s+const\\s+${symbol}\\s*=\\s*\\[`);
  const m = marker.exec(source);
  if (!m) throw new Error(`${rel(file)}: could not find "export const ${symbol} = [".`);
  const start = m.index + m[0].length - 1; // position of the opening '['
  // Walk forward tracking bracket depth, skipping strings and comments, to find the match.
  let depth = 0;
  let i = start;
  let inLine = false;
  let inBlock = false;
  let str = null; // current string-quote char or null
  for (; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];
    if (inLine) {
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (str) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === str) str = null;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      str = c;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`${rel(file)}: unbalanced brackets after "${symbol}".`);
  const literal = source.slice(start, i + 1);
  try {
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return (${literal});`)();
  } catch (err) {
    throw new Error(`${rel(file)}: failed to evaluate ${symbol} literal: ${err.message}`);
  }
}

/** Canonical signature of an ABI item: type + name + input types (distinguishes overloads). */
function sig(item) {
  const kind = item.type ?? 'function';
  const name = item.name ?? '';
  const inTypes = (item.inputs ?? []).map((p) => p.type).join(',');
  return `${kind}:${name}(${inTypes})`;
}

/** Normalize a single param (drop artifact-only `internalType`; keep name/type/indexed). */
function normParam(p) {
  const out = { name: p.name ?? '', type: p.type };
  if (p.indexed !== undefined) out.indexed = p.indexed;
  if (p.components) out.components = p.components.map(normParam);
  return out;
}

/** Normalize an ABI fragment to the fields that matter for encoding/decoding. */
function normFragment(item) {
  const out = { type: item.type ?? 'function' };
  if (item.name !== undefined) out.name = item.name;
  if (item.stateMutability !== undefined) out.stateMutability = item.stateMutability;
  // `anonymous` only applies to events and defaults to false when omitted; normalize so a
  // consumer that leaves it implicit is not flagged against an artifact that spells it out.
  if (out.type === 'event') out.anonymous = item.anonymous ?? false;
  out.inputs = (item.inputs ?? []).map(normParam);
  if (item.outputs !== undefined) out.outputs = item.outputs.map(normParam);
  return out;
}

function main() {
  const canonRaw = JSON.parse(readFileSync(CANONICAL, 'utf8'));
  const canonArr = Array.isArray(canonRaw) ? canonRaw : canonRaw.abi;
  if (!Array.isArray(canonArr)) {
    console.error(`ERROR ${rel(CANONICAL)}: not an ABI array (and no .abi field).`);
    process.exit(1);
  }
  const canonBySig = new Map();
  const canonByName = new Map(); // type:name → [items] for friendlier "not found" diagnostics
  for (const item of canonArr) {
    canonBySig.set(sig(item), item);
    const key = `${item.type ?? 'function'}:${item.name ?? ''}`;
    if (!canonByName.has(key)) canonByName.set(key, []);
    canonByName.get(key).push(item);
  }

  const problems = [];
  for (const { file, symbol } of CONSUMERS) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      problems.push(`${rel(file)}: file not found.`);
      continue;
    }
    let abi;
    try {
      abi = extractAbi(source, symbol, file);
    } catch (err) {
      problems.push(err.message);
      continue;
    }
    for (const item of abi) {
      const canon = canonBySig.get(sig(item));
      if (!canon) {
        const byName = canonByName.get(`${item.type ?? 'function'}:${item.name ?? ''}`);
        const hint = byName?.length
          ? ` (canonical has ${byName.map(sig).join(', ')} — signature mismatch)`
          : ' (no fragment of that type+name in the artifact)';
        problems.push(`${rel(file)}: ${sig(item)} not found in ${rel(CANONICAL)}${hint}.`);
        continue;
      }
      const a = JSON.stringify(normFragment(item));
      const b = JSON.stringify(normFragment(canon));
      if (a !== b) {
        problems.push(
          `${rel(file)}: ${sig(item)} DRIFTED from ${rel(CANONICAL)}.\n` +
            `    consumer : ${a}\n` +
            `    canonical: ${b}`,
        );
      }
    }
  }

  if (problems.length) {
    console.error(`ABI drift check FAILED (${problems.length} issue(s)):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\nThe canonical Router ABI is ${rel(CANONICAL)}.\n` +
        `Fix the drifted fragment(s) in the consumer file(s) to match it, or (if the\n` +
        `contract itself changed) regenerate the artifact with\n` +
        `  forge inspect Access0x1Router abi > ${rel(CANONICAL)}\n` +
        `then re-run this check.`,
    );
    process.exit(1);
  }

  const total = CONSUMERS.length;
  console.log(
    `ABI drift check OK — every fragment in ${total} consumer copy(ies) matches ${rel(CANONICAL)}.`,
  );
}

main();
