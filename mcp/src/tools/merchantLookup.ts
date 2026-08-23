/**
 * merchant_lookup — resolve one merchant from the indexed history, by router id
 * or by current owner address. Dormant when no subgraph is configured.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { readMerchant, type MerchantSelector } from '../subgraph.js';
import { big, dormant, failure, ok, subgraphProvenance } from './shared.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_RE = /^\d+$/;

/**
 * Register the `merchant_lookup` tool.
 *
 * @param server The MCP server.
 * @param ctx The shared tool context.
 */
export function registerMerchantLookup(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'merchant_lookup',
    {
      title: 'Look up a merchant',
      description:
        "Look up a merchant's indexed aggregate — owner, payout, fee, active flag, payment count, and " +
        'cumulative USD volume — by router merchant id OR by current owner address. Supply exactly one. ' +
        'Returns "as of block N" and the indexer health flag. Dormant when no subgraph is configured.',
      inputSchema: {
        merchantId: z
          .string()
          .regex(DECIMAL_RE)
          .optional()
          .describe('Router merchant id as a decimal string, e.g. "49"'),
        ownerAddress: z
          .string()
          .regex(ADDRESS_RE)
          .optional()
          .describe('Current owner EVM address, e.g. "0xabc…"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ merchantId, ownerAddress }) => {
      const url = ctx.config.subgraphUrl;
      if (url === null) {
        return dormant('subgraph', 'set ACCESS0X1_SUBGRAPH_URL to enable indexed merchant lookups');
      }

      // Guard: exactly one selector. The schema allows both-optional; the semantic
      // rule (exactly one) lives here.
      const hasId = typeof merchantId === 'string';
      const hasOwner = typeof ownerAddress === 'string';
      if (hasId === hasOwner) {
        return failure('supply exactly one of merchantId or ownerAddress');
      }

      const selector: MerchantSelector = hasId
        ? { by: 'merchantId', merchantId: BigInt(merchantId as string) }
        : { by: 'owner', owner: ownerAddress as string };

      const outcome = await readMerchant(url, selector, ctx.fetch);
      if (outcome.status === 'failed') {
        return failure(`subgraph is configured but the read failed: ${outcome.reason}`);
      }

      const m = outcome.data.merchant;
      const provenance = subgraphProvenance(outcome.meta);
      if (m === null) {
        return ok('no merchant matched at this block', {
          status: 'ok',
          found: false,
          merchant: null,
          provenance,
        });
      }

      return ok(
        `merchant ${big(m.merchantId)} — ${big(m.paymentCount)} payments, cumulative usd8 ${big(m.totalUsd8)}` +
          ` (${provenance.asOfBlock === null ? 'block unknown' : `as of block ${provenance.asOfBlock}`})`,
        {
          status: 'ok',
          found: true,
          merchant: {
            merchantId: big(m.merchantId),
            owner: m.owner,
            payout: m.payout,
            feeBps: m.feeBps,
            active: m.active,
            paymentCount: big(m.paymentCount),
            totalUsd8: big(m.totalUsd8),
            lastPaymentAt: big(m.lastPaymentAt),
          },
          provenance,
        },
      );
    },
  );
}
