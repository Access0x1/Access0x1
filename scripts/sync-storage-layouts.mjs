#!/usr/bin/env node
/**
 * @file sync-storage-layouts.mjs — the STORAGE-LAYOUT SAFETY LAW for upgradeable modules.
 *
 * THE ONE IRREVERSIBLE MISTAKE in a UUPS system is shipping an implementation whose storage layout is
 * incompatible with the live proxy's — a reordered / inserted / removed / retyped slot silently
 * corrupts every existing value and CANNOT be undone by another upgrade. This guard makes that class
 * impossible to merge, structurally, mirroring the repo's ABI law (scripts/sync-deployed-abis.mjs):
 *
 *   - Each upgradeable module has a COMMITTED snapshot storage-layouts/<Module>.json — the normalized
 *     `forge inspect <M> storage-layout`.
 *   - The default CHECK mode re-inspects the current build and asserts, per module, an APPEND-ONLY
 *     invariant against the snapshot:
 *       (a) every pre-existing slot is byte-identical — same {label, slot, offset, type, bytes, sig}.
 *           This catches reorder, insert-before, retype, and removal.
 *       (b) the trailing `__gap`'s END slot (slot + length) is UNCHANGED. New storage may ONLY be
 *           appended by consuming the gap; the reserved region's end never moves. This catches a gap
 *           shrunk by the wrong amount, or storage grown past the reserve.
 *
 * WHY `sig` EXISTS (the brick the naive guard missed): the dominant storage pattern here is a struct
 * behind a mapping/array — e.g. Access0x1Escrow `_escrows :: mapping(uint256 => struct Escrow)`. At the
 * TOP level that is ONE 32-byte slot whose type LABEL never changes when you reorder / insert / retype
 * a field INSIDE `Escrow`. Comparing only the top-level {label,type,bytes} is therefore blind to exactly
 * the edit that corrupts every existing escrow record. `sig` is a fully-resolved, astId-free fingerprint
 * of the WHOLE type tree (struct members with their slots/offsets/types, mapping key+value, array
 * base+length), recursed through the layout's `types` table — so any member-level change trips (a).
 *
 * Because every OZ 5.x parent here is ERC-7201 namespaced (each module's own storage starts at slot 0),
 * inheritance-order changes cannot shift linear slots — the __gap + append-only discipline IS the
 * governing guard, and that is precisely what this polices.
 *
 * USAGE
 *   node scripts/sync-storage-layouts.mjs            # CHECK (CI / pre-upgrade gate): exit 1 on drift
 *   node scripts/sync-storage-layouts.mjs --check    # same (explicit)
 *   node scripts/sync-storage-layouts.mjs --write     # (re)generate storage-layouts/ from the build
 *   MODULE=Access0x1Escrow node scripts/…            # scope to ONE module (used by `make upgrade-<chain>`)
 *
 * CHECK reads the fresh build via `forge inspect`, so `forge build` (or `make build`) must run first.
 * `--write` is the ONLY mode that touches storage-layouts/. Seed once with --write, review, commit;
 * thereafter --write (`make upgrade-snapshot`) is a SEPARATE, reviewed step — it is never reached from an
 * `upgrade-<chain>` broadcast target (those only run the read-only CHECK), so a broadcast can never
 * silently re-baseline the very snapshot it is being checked against.
 *
 * MODULE scoping: the broadcast targets pass MODULE=<Contract> so the pre-upgrade CHECK validates ONLY
 * the module being upgraded — an unrelated, not-yet-snapshotted WIP layout edit in another module cannot
 * block (and thus cannot pressure a blanket `--write` over) the upgrade you are running. CI runs it with
 * no MODULE = the full-fleet sweep.
 *
 * OPTIONAL SEMANTIC BACKSTOP (not wired here on purpose): OpenZeppelin foundry-upgrades
 * `Upgrades.validateUpgrade` does a reference-vs-new semantic diff, but it needs ffi + build_info +
 * the upgrades-core npm package and is unproven on this repo's foundry-zksync fork — see
 * docs/UPGRADING.md. This snapshot guard is the always-on, zero-dependency gate.
 *
 * RESIDUAL (documented, not enforced here): the snapshot is diffed against current SOURCE, not against
 * the impl bytecode actually live in each proxy. The append-only guarantee is transitive only if every
 * deployed version passed this CHECK before it shipped — so `--write` must only ever be run over
 * reviewed, append-only source that is (or is about to be) the deployed source. Pinning the snapshot to
 * the deployed impl's codehash per chain is the recommended next hardening.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'storage-layouts');
const WRITE = process.argv.includes('--write');
const ONLY = (process.env.MODULE || '').trim();

// The upgradeable modules (name -> source path). EXACTLY the src/ contracts that inherit
// UUPSUpgradeable — the set whose proxies a bad layout can brick. HouseToken (per-token, not proxied)
// and Access0x1Receiver (not upgradeable) are intentionally absent.
const MODULES = {
  Access0x1Router: 'src/Access0x1Router.sol',
  PaymentLanes: 'src/PaymentLanes.sol',
  ChainRegistry: 'src/ChainRegistry.sol',
  SessionGrant: 'src/SessionGrant.sol',
  PriceOracleAdapter: 'src/PriceOracleAdapter.sol',
  Access0x1Subscriptions: 'src/Access0x1Subscriptions.sol',
  Access0x1Bookings: 'src/Access0x1Bookings.sol',
  Access0x1Invoices: 'src/Access0x1Invoices.sol',
  Access0x1GiftCards: 'src/Access0x1GiftCards.sol',
  Access0x1Nft: 'src/Access0x1Nft.sol',
  Access0x1Escrow: 'src/Access0x1Escrow.sol',
  Receivables: 'src/Receivables.sol',
  Refunds: 'src/Refunds.sol',
  SplitSettler: 'src/SplitSettler.sol',
  GaslessPayIn: 'src/GaslessPayIn.sol',
  AutomationGateway: 'src/AutomationGateway.sol',
  Access0x1ProvenanceRegistry: 'src/Access0x1ProvenanceRegistry.sol',
  HouseTokenFactory: 'src/HouseTokenFactory.sol',
  Access0x1Rebates: 'src/Access0x1Rebates.sol',
  Access0x1SponsorRegistry: 'src/Access0x1SponsorRegistry.sol',
};

// forge is on ~/.foundry/bin (the Makefile prepends it); resolve it the same way for direct `node` runs.
const FORGE = process.env.FORGE_BIN || 'forge';
const FORGE_ENV = { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH || ''}` };

/** Run `forge inspect <path>:<Name> storage-layout --json` and return the parsed object. */
function inspectLayout(name, path) {
  const raw = execFileSync(FORGE, ['inspect', `${path}:${name}`, 'storage-layout', '--json'], {
    cwd: REPO_ROOT,
    env: FORGE_ENV,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

/**
 * Fully-resolve one type id into an astId-free, structure-based signature by recursing through the
 * layout's `types` table. This is what makes a struct-internal / mapping-value / array-element change
 * visible — the piece the top-level {label,bytes} comparison is blind to.
 *   - struct  -> struct{ member#slot.offset=<sig>; … } (ordered members, so a reorder/insert trips it)
 *   - mapping -> mapping(<keySig>=>valueSig)
 *   - array   -> array[<numberOfBytes>](<baseSig>)  (length in bytes, so uint[50]->uint[49] trips it)
 *   - leaf    -> <label>:<numberOfBytes>            (so uint256->uint128 trips it)
 * `seen` breaks self-referential types (a struct reachable from its own member via a mapping/array).
 * Digits are masked in every fallback/cycle label so a churned astId can never itself cause a diff.
 */
function resolveType(typeId, types, seen) {
  const t = types[typeId];
  if (!t) return String(typeId).replace(/\d+/g, '#'); // unknown id: mask astIds, keep shape
  if (seen.has(typeId)) return `@cycle(${String(t.label ?? '').replace(/\d+/g, '#')})`;
  const seen2 = new Set(seen);
  seen2.add(typeId);

  if (Array.isArray(t.members)) {
    const mem = t.members
      .map((m) => `${m.label}#${m.slot}.${m.offset}=${resolveType(m.type, types, seen2)}`)
      .join(';');
    return `struct{${mem}}`;
  }
  if (t.encoding === 'mapping') {
    return `mapping(${resolveType(t.key, types, seen2)}=>${resolveType(t.value, types, seen2)})`;
  }
  if (t.base) {
    return `array[${t.numberOfBytes ?? '?'}](${resolveType(t.base, types, seen2)})`;
  }
  return `${t.label ?? String(typeId).replace(/\d+/g, '#')}:${t.numberOfBytes ?? '?'}`;
}

/**
 * Normalize a forge storage-layout into a slot-ordered array of entries. Each entry:
 *   { label, slot, offset, type, bytes, sig }
 * `type` + `bytes` are the readable top-level label + width; `sig` is the fully-resolved type tree
 * (the real safety signal). All are astId-free, so an unrelated recompile produces an identical entry.
 */
function normalize(layout) {
  const types = layout.types || {};
  return (layout.storage || []).map((s) => {
    const t = types[s.type] || {};
    return {
      label: s.label,
      slot: String(s.slot),
      offset: Number(s.offset),
      type: t.label ?? s.type,
      bytes: String(t.numberOfBytes ?? '0'),
      sig: resolveType(s.type, types, new Set()),
    };
  });
}

/** The trailing `__gap`'s end slot = slot + (numberOfBytes / 32). Requires a trailing __gap entry. */
function gapEnd(entries) {
  const last = entries[entries.length - 1];
  if (!last || last.label !== '__gap') return null;
  const slots = Number(BigInt(last.bytes) / 32n);
  return Number(last.slot) + slots;
}

function eqEntry(a, b) {
  return (
    a.label === b.label &&
    a.slot === b.slot &&
    a.offset === b.offset &&
    a.type === b.type &&
    a.bytes === b.bytes &&
    a.sig === b.sig
  );
}

const snapPath = (name) => join(OUT_DIR, `${name}.json`);
const ser = (entries) => `${JSON.stringify(entries, null, 2)}\n`;

function main() {
  const entries = ONLY
    ? Object.entries(MODULES).filter(([n]) => n === ONLY)
    : Object.entries(MODULES);
  if (ONLY && entries.length === 0) {
    console.error(`MODULE=${ONLY} is not a known upgradeable module (see scripts/sync-storage-layouts.mjs).`);
    process.exit(1);
  }

  if (WRITE) mkdirSync(OUT_DIR, { recursive: true });

  const problems = [];
  let wrote = 0;

  for (const [name, path] of entries) {
    let fresh;
    try {
      fresh = normalize(inspectLayout(name, path));
    } catch (e) {
      problems.push(`${name}: forge inspect failed — did you run \`forge build\`? (${e.message.split('\n')[0]})`);
      continue;
    }

    if (WRITE) {
      writeFileSync(snapPath(name), ser(fresh));
      wrote++;
      continue;
    }

    // CHECK mode.
    const p = snapPath(name);
    if (!existsSync(p)) {
      problems.push(`${name}: no committed snapshot storage-layouts/${name}.json — run \`make upgrade-snapshot\` and commit it.`);
      continue;
    }
    const old = JSON.parse(readFileSync(p, 'utf8'));

    // Guard against a stale, pre-`sig` snapshot: without sig the check is blind to struct-member edits.
    if (old.some((e) => e.sig === undefined)) {
      problems.push(`${name}: committed snapshot predates the struct-aware guard (no \`sig\`) — re-seed with \`make upgrade-snapshot\` and commit.`);
      continue;
    }

    // (a) pre-existing slots must be byte-identical: nothing before the gap may change. Compare
    //     everything up to (but not including) the OLD trailing __gap.
    const oldHeadLen = old.length && old[old.length - 1].label === '__gap' ? old.length - 1 : old.length;
    if (fresh.length < oldHeadLen) {
      problems.push(`${name}: layout SHRANK (${fresh.length} entries < ${oldHeadLen} pre-existing) — a slot was removed. BRICKING.`);
      continue;
    }
    let mismatched = false;
    for (let i = 0; i < oldHeadLen; i++) {
      if (!eqEntry(fresh[i], old[i])) {
        problems.push(
          `${name}: slot #${i} changed — was ${JSON.stringify(old[i])}, now ${JSON.stringify(fresh[i])}. ` +
            `Reorder / insert-before / retype / removal (incl. INSIDE a struct/array/mapping value) all BRICK the proxy. Append new vars BEFORE the __gap only.`
        );
        mismatched = true;
        break;
      }
    }
    if (mismatched) continue;

    // (b) the reserved region's END must not move. New storage may only be carved out of the __gap.
    const oldEnd = gapEnd(old);
    const newEnd = gapEnd(fresh);
    if (oldEnd === null) {
      problems.push(`${name}: committed snapshot has no trailing __gap — re-seed with \`make upgrade-snapshot\`.`);
      continue;
    }
    if (newEnd === null) {
      problems.push(`${name}: current layout has no trailing __gap — every upgradeable module MUST keep a trailing \`uint256[N] private __gap\`.`);
      continue;
    }
    if (oldEnd !== newEnd) {
      problems.push(
        `${name}: __gap END slot moved ${oldEnd} -> ${newEnd}. Appended storage must shrink __gap by EXACTLY the slots it adds ` +
          `(the reserved region's end is fixed). Off-by-N here means a future upgrade will collide.`
      );
      continue;
    }
  }

  if (WRITE) {
    console.log(`storage-layouts: wrote ${wrote} snapshot(s) to storage-layouts/. Review + commit them.`);
    return;
  }

  if (problems.length) {
    console.error('STORAGE-LAYOUT GUARD: FAIL\n');
    for (const m of problems) console.error(`  ✗ ${m}`);
    console.error('\nIf a change is a legitimate append: add vars BEFORE __gap, shrink __gap by the same slot count,');
    console.error('run `make upgrade-snapshot`, review the diff, and commit. Never reorder/insert/remove/retype an existing slot.');
    process.exit(1);
  }
  console.log(`storage-layouts: OK — ${entries.length} module layout(s) are append-only compatible with their snapshots.`);
}

main();
