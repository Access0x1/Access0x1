/**
 * Package-level constants. The only "hardcoded" facts allowed here are about the
 * server itself (its name and version) — never a chain address, which always
 * comes from the manifest at runtime.
 */

/** The MCP server name advertised on initialize. */
export const SERVER_NAME = 'access0x1-mcp';

/** The MCP server version. Keep in sync with package.json `version`. */
export const SERVER_VERSION = '0.1.0';

/** Environment variable names this server reads. Centralized so the config module and docs never drift. */
export const ENV = {
  /** Local manifest file path (highest priority chain-facts source). */
  manifestPath: 'ACCESS0X1_MANIFEST_PATH',
  /** Fallback manifest URL (raw JSON). */
  manifestUrl: 'ACCESS0X1_MANIFEST_URL',
  /** Optional subgraph GraphQL endpoint. Unset → indexed-history tools are dormant. */
  subgraphUrl: 'ACCESS0X1_SUBGRAPH_URL',
  /** Optional web app base origin. Unset → checkout / agent tools are dormant. */
  webBaseUrl: 'ACCESS0X1_WEB_BASE_URL',
  /** Optional shared caller-auth token forwarded to the agent-pay route. Never a spending key. */
  agentInternalSecret: 'ACCESS0X1_AGENT_INTERNAL_SECRET',
} as const;
