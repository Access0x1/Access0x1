/**
 * verify_payment — "has this merchant's payment landed?" answered from indexed
 * state, using the rail's conservative release-decision pattern. Returns a typed
 * verdict, the reasoning that narrates why, "as of block N", and the indexer
 * health. Degrades to "not verified" on any index problem. Dormant when no
 * subgraph is configured.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { decideVerification, thresholdsFromInput, type VerificationRead } from '../insight.js';
import { readMerchant } from '../subgraph.js';
import { bigOrNull, dormant, ok } from './shared.js';

const DECIMAL_RE = /^\d+$/;

/**
 * Register the `verify_payment` tool.
 *
 * @param server The MCP server.
 * @param ctx The shared tool context.
 */
export function registerVerifyPayment(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'verify_payment',
    {
      title: 'Verify payment landed',
      description:
        "Decide whether a merchant's INDEXED payment state clears your thresholds before releasing a service: " +
        'at least one settled payment, optional minimum cumulative USD (minUsd), and an optional recency window ' +
        '(maxAgeSeconds). Always reports "as of block N" and whether the index was healthy, and DEGRADES to ' +
        '"not verified" on any index error or staleness — never assumes goodwill. Dormant when no subgraph is configured.',
      inputSchema: {
        merchantId: z.string().regex(DECIMAL_RE).describe('Router merchant id as a decimal string'),
        minUsd: z
          .number()
          .positive()
          .optional()
          .describe('Minimum cumulative indexed USD (whole dollars). Omit for no volume floor.'),
        maxAgeSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Require the last payment within this many seconds. Omit to skip the recency gate.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ merchantId, minUsd, maxAgeSeconds }) => {
      const url = ctx.config.subgraphUrl;
      if (url === null) {
        return dormant('subgraph', 'set ACCESS0X1_SUBGRAPH_URL to enable indexed payment verification');
      }

      const outcome = await readMerchant(url, { by: 'merchantId', merchantId: BigInt(merchantId) }, ctx.fetch);

      // A failed read maps to `null` so the decision core degrades conservatively
      // to "not verified" — exactly like the rail's own agent-insight module.
      const read: VerificationRead | null =
        outcome.status === 'failed'
          ? null
          : {
              merchant: outcome.data.merchant
                ? {
                    paymentCount: outcome.data.merchant.paymentCount,
                    totalUsd8: outcome.data.merchant.totalUsd8,
                    lastPaymentAt: outcome.data.merchant.lastPaymentAt,
                  }
                : null,
              asOfBlock: outcome.meta.asOfBlock,
              hasIndexingErrors: outcome.meta.hasIndexingErrors,
            };

      const decision = decideVerification(read, {
        nowSeconds: ctx.nowSeconds(),
        thresholds: thresholdsFromInput(minUsd, maxAgeSeconds),
      });

      return ok(
        `${decision.verified ? 'VERIFIED' : 'NOT VERIFIED'} — merchant ${merchantId}` +
          ` (${decision.asOfBlock === null ? 'block unknown' : `as of block ${decision.asOfBlock}`}` +
          `${decision.indexingHealthy ? '' : ', index degraded'})`,
        {
          status: 'ok',
          merchantId,
          verified: decision.verified,
          indexingHealthy: decision.indexingHealthy,
          asOfBlock: bigOrNull(decision.asOfBlock),
          reasoning: decision.reasoning,
          provenance: { source: 'subgraph', endpoint: 'configured' },
        },
      );
    },
  );
}
