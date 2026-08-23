/**
 * network_leaderboard — the top merchants across the whole rail by indexed USD
 * volume. A cross-entity ranking a per-contract on-chain scan cannot do; the
 * value a shared index adds. Dormant when no subgraph is configured.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { readLeaderboard } from '../subgraph.js';
import { big, dormant, failure, ok, subgraphProvenance } from './shared.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Register the `network_leaderboard` tool.
 *
 * @param server The MCP server.
 * @param ctx The shared tool context.
 */
export function registerNetworkLeaderboard(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'network_leaderboard',
    {
      title: 'Network leaderboard',
      description:
        'Rank the top merchants across the whole rail by cumulative indexed USD volume (8 decimals). ' +
        'Returns "as of block N" and the indexer health flag. Dormant when no subgraph is configured.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Max rows to return (1–${MAX_LIMIT}; default ${DEFAULT_LIMIT})`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      const url = ctx.config.subgraphUrl;
      if (url === null) {
        return dormant('subgraph', 'set ACCESS0X1_SUBGRAPH_URL to enable the network leaderboard');
      }

      const clamped = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const outcome = await readLeaderboard(url, clamped, ctx.fetch);
      if (outcome.status === 'failed') {
        return failure(`subgraph is configured but the read failed: ${outcome.reason}`);
      }

      const provenance = subgraphProvenance(outcome.meta);
      const merchants = outcome.data.merchants.map((m, i) => ({
        rank: i + 1,
        merchantId: big(m.merchantId),
        owner: m.owner,
        paymentCount: big(m.paymentCount),
        totalUsd8: big(m.totalUsd8),
        lastPaymentAt: big(m.lastPaymentAt),
      }));

      return ok(
        `top ${merchants.length} merchant(s) by indexed USD volume` +
          ` (${provenance.asOfBlock === null ? 'block unknown' : `as of block ${provenance.asOfBlock}`})`,
        {
          status: 'ok',
          count: merchants.length,
          merchants,
          provenance,
        },
      );
    },
  );
}
