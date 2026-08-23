/**
 * list_chains — enumerate the chains the rail is deployed on, straight from the
 * manifest. No chain fact is baked into this code; the list is whatever the
 * configured manifest publishes, tagged with where it was loaded from.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { listChains } from '../manifest.js';
import { manifestProvenance, ok } from './shared.js';

/**
 * Register the `list_chains` tool.
 *
 * @param server The MCP server.
 * @param ctx The shared tool context.
 */
export function registerListChains(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_chains',
    {
      title: 'List rail chains',
      description:
        'List every chain the Access0x1 payments rail is deployed on — id, name, router address, and ' +
        'whether the manifest asserts the contracts are source-verified. Facts come from the rail manifest ' +
        'at runtime, never from memory. Call this first to discover which chains you can operate on.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const chains = listChains(ctx.manifest);
      const summary =
        `${chains.length} chain(s) from the rail manifest: ` +
        chains.map((c) => `${c.name} (${c.id})`).join(', ');
      return ok(summary, {
        status: 'ok',
        count: chains.length,
        chains: chains.map((c) => ({
          id: c.id,
          name: c.name,
          router: c.router,
          verified: c.verified,
        })),
        provenance: manifestProvenance(ctx),
      });
    },
  );
}
