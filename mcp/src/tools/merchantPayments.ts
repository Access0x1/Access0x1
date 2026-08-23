/**
 * merchant_payments — a merchant's most-recent settled payments, newest first,
 * from the indexed history. Dormant when no subgraph is configured.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { readMerchantPayments } from '../subgraph.js';
import { big, dormant, failure, ok, subgraphProvenance } from './shared.js';

const DECIMAL_RE = /^\d+$/;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Register the `merchant_payments` tool.
 *
 * @param server The MCP server.
 * @param ctx The shared tool context.
 */
export function registerMerchantPayments(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'merchant_payments',
    {
      title: 'Merchant payments',
      description:
        "List a merchant's most-recent settled payments (newest first) from the indexed history — buyer, " +
        'token, gross/fee/net amounts, USD amount (8 decimals), block. Returns "as of block N" and the ' +
        'indexer health flag. Dormant when no subgraph is configured.',
      inputSchema: {
        merchantId: z.string().regex(DECIMAL_RE).describe('Router merchant id as a decimal string'),
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
    async ({ merchantId, limit }) => {
      const url = ctx.config.subgraphUrl;
      if (url === null) {
        return dormant('subgraph', 'set ACCESS0X1_SUBGRAPH_URL to enable indexed payment history');
      }

      const clamped = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const outcome = await readMerchantPayments(url, BigInt(merchantId), clamped, ctx.fetch);
      if (outcome.status === 'failed') {
        return failure(`subgraph is configured but the read failed: ${outcome.reason}`);
      }

      const provenance = subgraphProvenance(outcome.meta);
      const payments = outcome.data.payments.map((p) => ({
        txHash: p.txHash,
        buyer: p.buyer,
        token: p.token,
        grossAmount: big(p.grossAmount),
        feeAmount: big(p.feeAmount),
        netAmount: big(p.netAmount),
        usdAmount8: big(p.usdAmount8),
        blockNumber: big(p.blockNumber),
        blockTimestamp: big(p.blockTimestamp),
      }));

      return ok(
        `${payments.length} payment(s) for merchant ${merchantId}` +
          ` (${provenance.asOfBlock === null ? 'block unknown' : `as of block ${provenance.asOfBlock}`})`,
        {
          status: 'ok',
          merchantId,
          count: payments.length,
          payments,
          provenance,
        },
      );
    },
  );
}
