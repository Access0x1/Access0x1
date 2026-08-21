/**
 * chain_facts — the full address set for one chain: router, USDC, price feeds,
 * an explorer link, and an RPC. Every value is read from the manifest; a fact the
 * manifest does not carry is returned as `null`, never invented.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { explorerAddressLink, findChain } from '../manifest.js';
import { failure, manifestProvenance, ok } from './shared.js';

/**
 * Register the `chain_facts` tool.
 *
 * @param server The MCP server.
 * @param ctx The shared tool context.
 */
export function registerChainFacts(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'chain_facts',
    {
      title: 'Chain facts',
      description:
        'Get the address set the rail uses on one chain — payment router, settlement USDC, native/USD and ' +
        'USDC/USD price feeds, a block-explorer base, and a public RPC. All read from the manifest at runtime. ' +
        'A field the manifest does not list is returned as null (never guessed). Use list_chains to discover ids.',
      inputSchema: {
        chainId: z.number().int().positive().describe('EIP-155 chain id, e.g. 84532 for Base Sepolia'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ chainId }) => {
      const chain = findChain(ctx.manifest, chainId);
      if (!chain) {
        const known = ctx.manifest.chains.map((c) => c.id).join(', ');
        return failure(`chain ${chainId} is not in the manifest`, { knownChainIds: known });
      }
      return ok(`${chain.name} (${chain.id}) — router ${chain.router}`, {
        status: 'ok',
        chain: {
          id: chain.id,
          name: chain.name,
          router: chain.router,
          usdc: chain.usdc,
          nativeUsdFeed: chain.nativeUsdFeed,
          usdcUsdFeed: chain.usdcUsdFeed,
          explorerUrl: chain.explorerUrl,
          routerExplorerLink: explorerAddressLink(chain, chain.router),
          rpcUrl: chain.rpcUrl,
          verified: chain.verified,
        },
        provenance: manifestProvenance(ctx),
      });
    },
  );
}
