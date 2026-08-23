/**
 * config.ts — every external fact this server needs comes from the environment,
 * resolved once here with fail-fast validation and explicit DORMANT-not-broken
 * semantics for the optional capabilities.
 *
 * Required: a chain-facts manifest source. At least one of ACCESS0X1_MANIFEST_PATH
 * or ACCESS0X1_MANIFEST_URL must be set — without it the server has no source of
 * chain addresses at all, and (by design) it never falls back to hardcoded
 * addresses, so it refuses to start.
 *
 * Optional: the subgraph URL (indexed history) and the web base URL (hosted
 * checkout + agent-pay). When unset, the tools that depend on them report a
 * clear "dormant" result — the capability is ABSENT, not failed.
 */

import { ENV } from './constants.js';
import { ConfigError } from './errors.js';

/** A single ordered manifest source, tried in priority order at load time. */
export interface ManifestSource {
  /** `path` reads a local JSON file; `url` fetches raw JSON over HTTP(S). */
  readonly kind: 'path' | 'url';
  /** The file path or URL. */
  readonly value: string;
}

/** The fully-resolved, validated runtime configuration. */
export interface RailConfig {
  /** Ordered manifest sources (path preferred, url fallback). Never empty. */
  readonly manifestSources: readonly ManifestSource[];
  /** The subgraph GraphQL endpoint, or `null` when the indexed-history seam is dormant. */
  readonly subgraphUrl: string | null;
  /** The web app base origin (no trailing slash), or `null` when checkout/agent tools are dormant. */
  readonly webBaseUrl: string | null;
  /** The shared caller-auth token for the agent-pay route, or `null` when not provided. Never a spending key. */
  readonly agentInternalSecret: string | null;
}

/** An environment-like record. Injected in tests; defaults to `process.env`. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Read a trimmed, non-empty string from the environment, or `null` when the key
 * is unset or blank. Blank-is-unset keeps an accidental empty assignment
 * (`FOO=`) from being treated as a configured value.
 *
 * @param env The environment record.
 * @param key The variable name.
 * @returns The trimmed value, or `null` when unset/blank.
 */
function readOptional(env: EnvLike, key: string): string | null {
  const raw = (env[key] ?? '').trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Strip a trailing slash so a base URL joins cleanly with a leading-slash path.
 *
 * @param value A base URL.
 * @returns The URL without any trailing slashes.
 */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Resolve and validate the runtime configuration from an environment record.
 *
 * @param env The environment record; defaults to `process.env`.
 * @returns The validated {@link RailConfig}.
 * @throws {ConfigError} When no manifest source is configured, or the web base URL is set but unparseable.
 */
export function loadConfig(env: EnvLike = process.env): RailConfig {
  const manifestPath = readOptional(env, ENV.manifestPath);
  const manifestUrl = readOptional(env, ENV.manifestUrl);

  const manifestSources: ManifestSource[] = [];
  if (manifestPath) {
    manifestSources.push({ kind: 'path', value: manifestPath });
  }
  if (manifestUrl) {
    manifestSources.push({ kind: 'url', value: manifestUrl });
  }
  if (manifestSources.length === 0) {
    throw new ConfigError(
      `No chain-facts manifest configured. Set ${ENV.manifestPath} (a local JSON file) ` +
        `and/or ${ENV.manifestUrl} (a raw JSON URL). This server never hardcodes chain ` +
        `addresses, so it cannot start without a manifest source.`,
    );
  }

  const webBaseRaw = readOptional(env, ENV.webBaseUrl);
  let webBaseUrl: string | null = null;
  if (webBaseRaw) {
    try {
      // Validate it parses as a URL; store the normalized origin-preserving form
      // without a trailing slash. Never place data in this URL — it is a base only.
      const parsed = new URL(webBaseRaw);
      webBaseUrl = stripTrailingSlash(parsed.toString());
    } catch {
      throw new ConfigError(`${ENV.webBaseUrl} is set but is not a valid URL: ${webBaseRaw}`);
    }
  }

  return {
    manifestSources,
    subgraphUrl: readOptional(env, ENV.subgraphUrl),
    webBaseUrl,
    agentInternalSecret: readOptional(env, ENV.agentInternalSecret),
  };
}

/**
 * A short human description of the manifest sources for provenance and logs.
 *
 * @param sources The resolved manifest sources.
 * @returns e.g. `"path:./manifest.json, url:https://…"`.
 */
export function describeManifestSources(sources: readonly ManifestSource[]): string {
  return sources.map((s) => `${s.kind}:${s.value}`).join(', ');
}
