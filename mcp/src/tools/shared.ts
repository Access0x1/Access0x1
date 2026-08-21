/**
 * shared.ts — helpers every tool uses: JSON-safe serialization of bigints,
 * provenance stamps, and the three result shapes (ok / dormant / failure).
 *
 * Provenance is a first-class part of every result: an agent should be able to
 * see WHERE a fact came from. Two deliberate redactions: the subgraph endpoint is
 * never echoed (a hosted indexer URL can embed a query key), and no caller-auth
 * secret ever appears in a result.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from '../context.js';
import type { IndexMeta } from '../subgraph.js';

/** Serialize a bigint to its decimal string (JSON has no bigint). */
export function big(value: bigint): string {
  return value.toString();
}

/** Serialize a nullable bigint to a decimal string or `null`. */
export function bigOrNull(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

/** Provenance for a fact that came from the manifest. */
export interface ManifestProvenanceStamp {
  readonly source: 'manifest';
  readonly via: 'path' | 'url';
  readonly ref: string;
  readonly loadedAt: string;
  readonly namespace: string | null;
}

/** Provenance for a fact that came from the subgraph (endpoint redacted). */
export interface SubgraphProvenanceStamp {
  readonly source: 'subgraph';
  /** The endpoint is configured; its URL is intentionally not echoed. */
  readonly endpoint: 'configured';
  readonly asOfBlock: string | null;
  readonly hasIndexingErrors: boolean;
}

/** Provenance for a fact/link that came from the web app base URL. */
export interface WebProvenanceStamp {
  readonly source: 'web';
  readonly baseUrl: string;
}

/**
 * Build the manifest provenance stamp from the context.
 *
 * @param ctx The tool context.
 * @returns The manifest provenance stamp.
 */
export function manifestProvenance(ctx: ToolContext): ManifestProvenanceStamp {
  const p = ctx.manifest.provenance;
  return {
    source: 'manifest',
    via: p.via,
    ref: p.ref,
    loadedAt: p.loadedAt,
    namespace: ctx.manifest.namespace,
  };
}

/**
 * Build the subgraph provenance stamp from an index-meta reading.
 *
 * @param meta The indexer health/height from the read.
 * @returns The subgraph provenance stamp (endpoint URL redacted).
 */
export function subgraphProvenance(meta: IndexMeta): SubgraphProvenanceStamp {
  return {
    source: 'subgraph',
    endpoint: 'configured',
    asOfBlock: bigOrNull(meta.asOfBlock),
    hasIndexingErrors: meta.hasIndexingErrors,
  };
}

/**
 * A successful tool result: a human summary plus JSON-safe structured content.
 *
 * @param summary A one-line human-readable summary for the text channel.
 * @param structured The JSON-safe structured payload (must contain no bigints).
 * @returns The MCP tool result.
 */
export function ok(summary: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: structured,
  };
}

/**
 * A dormant-capability result: NOT an error. The capability is absent (an
 * optional env is unset), and the agent should proceed as if the tool had no
 * opinion rather than treating this as a failure.
 *
 * @param capability The capability name (e.g. `"subgraph"`).
 * @param message A clear explanation of what to configure to activate it.
 * @param extra Optional extra structured fields.
 * @returns The MCP tool result with `status: "dormant"`.
 */
export function dormant(
  capability: string,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult {
  return {
    content: [{ type: 'text', text: `dormant (${capability}): ${message}` }],
    structuredContent: { status: 'dormant', capability, message, ...extra },
  };
}

/**
 * A failure result: the capability IS configured but this call could not
 * complete. Marked `isError` so the host surfaces it as a tool error.
 *
 * @param message The failure reason (never a secret or a stack trace).
 * @param extra Optional extra structured fields.
 * @returns The MCP tool result with `isError: true`.
 */
export function failure(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return {
    content: [{ type: 'text', text: `error: ${message}` }],
    structuredContent: { status: 'error', message, ...extra },
    isError: true,
  };
}
