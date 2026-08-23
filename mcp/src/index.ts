#!/usr/bin/env node
/**
 * index.ts — the stdio entrypoint. Resolve config (fail-fast), load the manifest
 * (fail-fast), build the server, and connect it over stdio.
 *
 * All human-facing logging goes to stderr — stdout is the MCP protocol channel
 * and must carry nothing else.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, describeManifestSources } from './config.js';
import { createContext } from './context.js';
import { createServer } from './server.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';

/**
 * Boot the server: config → manifest → server → stdio transport.
 *
 * @returns A promise that resolves once the transport is connected.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const ctx = await createContext(config);
  const server = createServer(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[${SERVER_NAME}] v${SERVER_VERSION} ready — ${ctx.manifest.chains.length} chain(s) from ` +
      `${describeManifestSources(config.manifestSources)}; ` +
      `subgraph ${config.subgraphUrl ? 'configured' : 'dormant'}, ` +
      `web ${config.webBaseUrl ? 'configured' : 'dormant'}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
