/**
 * manifest.ts — the rail's chain-facts manifest: its type, a fail-fast loader
 * (local file preferred, URL fallback), strict validation, and read accessors.
 *
 * This is the heart of the "never hardcode" story. Nothing in this package
 * carries a chain address; every router / USDC / feed address is data read from
 * a manifest the rail publishes. An agent asks this server for a fact and the
 * fact traces to the manifest, tagged with where it came from.
 */

import type { ManifestSource } from './config.js';
import { ManifestError } from './errors.js';
import type { HttpFetch } from './http.js';

/** An EVM address as written in the manifest (checksummed or lowercase, preserved verbatim). */
export type Address = string;

/** The per-chain facts an agent needs to operate the rail on one chain. */
export interface ChainFacts {
  /** EIP-155 chain id. */
  readonly id: number;
  /** Human chain name. */
  readonly name: string;
  /** The Access0x1 payment router (proxy) on this chain. */
  readonly router: Address;
  /** The settlement USDC token, or `null` when the manifest does not list one for this chain. */
  readonly usdc: Address | null;
  /** The native/USD Chainlink feed, or `null` when none is listed. */
  readonly nativeUsdFeed: Address | null;
  /** The USDC/USD Chainlink feed, or `null` when none is listed. */
  readonly usdcUsdFeed: Address | null;
  /** The block-explorer base URL (no trailing slash), or `null` when unknown. */
  readonly explorerUrl: string | null;
  /** A public RPC URL for this chain, or `null` when the manifest lists none. */
  readonly rpcUrl: string | null;
  /**
   * Whether the manifest ASSERTS the rail's contracts are source-verified on this
   * chain's explorer. `null` means the manifest makes no claim — read as "not
   * asserted", never as "unverified".
   */
  readonly verified: boolean | null;
}

/** Provenance describing where a loaded manifest actually came from. */
export interface ManifestProvenance {
  /** The source that succeeded: a local path or a URL. */
  readonly via: 'path' | 'url';
  /** The exact path or URL the manifest was read from. */
  readonly ref: string;
  /** ISO-8601 timestamp of when it was loaded. */
  readonly loadedAt: string;
}

/** A fully-parsed, validated manifest plus its provenance. */
export interface RailManifest {
  /** The rail namespace (e.g. `"access0x1.v1."`), or `null` when the manifest omits it. */
  readonly namespace: string | null;
  /** The mirror router address (identical across mirrored chains), or `null` when omitted. */
  readonly router: Address | null;
  /** The full mirror contract set (name → address), or `null` when the manifest omits it. */
  readonly contracts: Readonly<Record<string, Address>> | null;
  /** Every chain the manifest enumerates. */
  readonly chains: readonly ChainFacts[];
  /** Where this manifest was loaded from. */
  readonly provenance: ManifestProvenance;
}

/** A minimal file reader, so tests can inject a stub without a real filesystem. */
export type ReadFileLike = (path: string) => Promise<string>;

/** Dependencies the loader needs, injectable for tests. */
export interface ManifestLoaderDeps {
  readonly readFile: ReadFileLike;
  readonly fetch: HttpFetch;
  /** Clock for the `loadedAt` stamp; defaults to `Date.now`. */
  readonly now?: () => number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate that a value is a present, well-formed EVM address; throw otherwise.
 *
 * @param value The candidate value.
 * @param where A label for the error message (e.g. `"chains[2].router"`).
 * @returns The value, narrowed to a string.
 * @throws {ManifestError} When the value is missing or not a 20-byte hex address.
 */
function requireAddress(value: unknown, where: string): Address {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new ManifestError(`${where} must be a 0x-prefixed 20-byte address, got: ${String(value)}`);
  }
  return value;
}

/**
 * Coerce an optional address field to a validated address or `null`. A present
 * but malformed address fails fast — a silently-dropped bad address would let a
 * caller act on a missing fact without knowing it.
 *
 * @param value The candidate value (may be absent).
 * @param where A label for the error message.
 * @returns The validated address, or `null` when absent.
 * @throws {ManifestError} When the field is present but malformed.
 */
function optionalAddress(value: unknown, where: string): Address | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireAddress(value, where);
}

/**
 * Coerce an optional string field to a trimmed non-empty string or `null`.
 *
 * @param value The candidate value.
 * @param where A label for the error message.
 * @returns The trimmed string, or `null` when absent/blank.
 * @throws {ManifestError} When present but not a string.
 */
function optionalString(value: unknown, where: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ManifestError(`${where} must be a string when present, got: ${typeof value}`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate a single raw chain entry into {@link ChainFacts}.
 *
 * @param raw The untrusted chain object.
 * @param index The array index, for error messages.
 * @returns The validated chain facts.
 * @throws {ManifestError} On any missing/invalid required field.
 */
function parseChain(raw: unknown, index: number): ChainFacts {
  const at = `chains[${index}]`;
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestError(`${at} must be an object`);
  }
  const c = raw as Record<string, unknown>;

  if (typeof c.id !== 'number' || !Number.isInteger(c.id) || c.id <= 0) {
    throw new ManifestError(`${at}.id must be a positive integer chain id, got: ${String(c.id)}`);
  }
  if (typeof c.name !== 'string' || c.name.trim().length === 0) {
    throw new ManifestError(`${at}.name must be a non-empty string`);
  }

  const explorer = optionalString(c.explorerUrl, `${at}.explorerUrl`);

  return {
    id: c.id,
    name: c.name.trim(),
    router: requireAddress(c.router, `${at}.router`),
    usdc: optionalAddress(c.usdc, `${at}.usdc`),
    nativeUsdFeed: optionalAddress(c.nativeUsdFeed, `${at}.nativeUsdFeed`),
    usdcUsdFeed: optionalAddress(c.usdcUsdFeed, `${at}.usdcUsdFeed`),
    explorerUrl: explorer === null ? null : explorer.replace(/\/+$/, ''),
    rpcUrl: optionalString(c.rpcUrl, `${at}.rpcUrl`),
    verified: typeof c.verified === 'boolean' ? c.verified : null,
  };
}

/**
 * Validate the full raw contracts map (name → address).
 *
 * @param raw The untrusted contracts value.
 * @returns The validated map, or `null` when absent.
 * @throws {ManifestError} When present but not an object of address strings.
 */
function parseContracts(raw: unknown): Record<string, Address> | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError('contracts must be an object of { name: address }');
  }
  const out: Record<string, Address> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    out[name] = requireAddress(value, `contracts.${name}`);
  }
  return out;
}

/**
 * Parse and validate a raw manifest string into a {@link RailManifest}.
 *
 * @param text The raw JSON text.
 * @param provenance Where the text was loaded from.
 * @returns The validated manifest.
 * @throws {ManifestError} On invalid JSON or any schema violation.
 */
export function parseManifest(text: string, provenance: ManifestProvenance): RailManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ManifestError(`manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ManifestError('manifest root must be a JSON object');
  }
  const root = json as Record<string, unknown>;

  if (!Array.isArray(root.chains)) {
    throw new ManifestError('manifest.chains must be an array');
  }
  if (root.chains.length === 0) {
    throw new ManifestError('manifest.chains must not be empty');
  }

  const chains = root.chains.map((raw, i) => parseChain(raw, i));

  // A duplicate chain id makes chain_facts ambiguous; reject it at load.
  const seen = new Set<number>();
  for (const chain of chains) {
    if (seen.has(chain.id)) {
      throw new ManifestError(`manifest has duplicate chain id ${chain.id}`);
    }
    seen.add(chain.id);
  }

  return {
    namespace: optionalString(root.namespace, 'namespace'),
    router: root.router === undefined || root.router === null ? null : requireAddress(root.router, 'router'),
    contracts: parseContracts(root.contracts),
    chains,
    provenance,
  };
}

/**
 * Load the manifest from the configured sources, in order, returning the first
 * that both loads and validates. Fail-fast: when every source fails, the
 * collected reasons are thrown as one {@link ManifestError}.
 *
 * @param sources Ordered manifest sources (path preferred, url fallback).
 * @param deps Injectable file reader + fetch + clock.
 * @returns The validated manifest with provenance.
 * @throws {ManifestError} When no source yields a valid manifest.
 */
export async function loadManifest(
  sources: readonly ManifestSource[],
  deps: ManifestLoaderDeps,
): Promise<RailManifest> {
  const now = deps.now ?? Date.now;
  const failures: string[] = [];

  for (const source of sources) {
    try {
      const provenance: ManifestProvenance = {
        via: source.kind,
        ref: source.value,
        loadedAt: new Date(now()).toISOString(),
      };
      if (source.kind === 'path') {
        const text = await deps.readFile(source.value);
        return parseManifest(text, provenance);
      }
      const res = await deps.fetch(source.value, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        throw new ManifestError(`HTTP ${res.status}`);
      }
      const text = await res.text();
      return parseManifest(text, provenance);
    } catch (err) {
      failures.push(`${source.kind}:${source.value} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new ManifestError(`could not load a valid manifest from any source. Attempts: ${failures.join(' | ')}`);
}

/** A compact per-chain summary for `list_chains`. */
export interface ChainSummary {
  readonly id: number;
  readonly name: string;
  readonly router: Address;
  readonly verified: boolean | null;
}

/**
 * The compact list of chains for `list_chains`, sorted by id for a stable order.
 *
 * @param manifest The loaded manifest.
 * @returns One summary per chain.
 */
export function listChains(manifest: RailManifest): ChainSummary[] {
  return manifest.chains
    .map((c) => ({ id: c.id, name: c.name, router: c.router, verified: c.verified }))
    .sort((a, b) => a.id - b.id);
}

/**
 * Find one chain's full facts by id.
 *
 * @param manifest The loaded manifest.
 * @param chainId The EIP-155 chain id to look up.
 * @returns The chain facts, or `undefined` when the manifest has no such chain.
 */
export function findChain(manifest: RailManifest, chainId: number): ChainFacts | undefined {
  return manifest.chains.find((c) => c.id === chainId);
}

/**
 * Build an explorer address link for a chain, or `null` when the chain has no
 * known explorer — the caller then shows the plain address, never an invented URL.
 *
 * @param chain The chain facts.
 * @param address The address to link.
 * @returns The `"{explorer}/address/{address}"` URL, or `null`.
 */
export function explorerAddressLink(chain: ChainFacts, address: Address): string | null {
  return chain.explorerUrl ? `${chain.explorerUrl}/address/${address}` : null;
}
