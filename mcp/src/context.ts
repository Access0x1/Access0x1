/**
 * context.ts — the shared runtime context every tool reads. Built once at boot:
 * it resolves the manifest eagerly so a bad manifest fails FAST at startup with a
 * named error, rather than surfacing as a confusing per-tool failure later.
 *
 * All I/O seams (file read, fetch, clock) are injectable so the whole tool layer
 * is unit-testable without a real filesystem, network, or wall clock.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import type { RailConfig } from './config.js';
import { defaultFetch, type HttpFetch } from './http.js';
import { loadManifest, type RailManifest, type ReadFileLike } from './manifest.js';

/** The context passed to every tool handler. */
export interface ToolContext {
  /** The resolved, validated configuration. */
  readonly config: RailConfig;
  /** The loaded, validated manifest (the chain-facts source). */
  readonly manifest: RailManifest;
  /** The injectable fetch used by the subgraph and web tools. */
  readonly fetch: HttpFetch;
  /** The current time in unix seconds — a testable clock for the verify decision. */
  readonly nowSeconds: () => bigint;
}

/** Injectable dependencies for {@link createContext} (defaults use Node built-ins). */
export interface ContextDeps {
  /** File reader for the manifest; defaults to `fs/promises.readFile(..., 'utf8')`. */
  readonly readFile?: ReadFileLike;
  /** HTTP fetch; defaults to the Node global `fetch` wrapper. */
  readonly fetch?: HttpFetch;
  /** Millisecond clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Build the tool context, loading the manifest from the configured sources.
 *
 * @param config The resolved configuration.
 * @param deps Optional injectable dependencies.
 * @returns The ready-to-use context.
 * @throws {ManifestError} When no configured manifest source yields a valid manifest.
 */
export async function createContext(config: RailConfig, deps: ContextDeps = {}): Promise<ToolContext> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const readFileImpl: ReadFileLike = deps.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));
  const nowMs = deps.now ?? Date.now;

  const manifest: RailManifest = await loadManifest(config.manifestSources, {
    readFile: readFileImpl,
    fetch: fetchImpl,
    now: nowMs,
  });

  return {
    config,
    manifest,
    fetch: fetchImpl,
    nowSeconds: () => BigInt(Math.floor(nowMs() / 1000)),
  };
}
