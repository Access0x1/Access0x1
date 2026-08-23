/**
 * checkout_link — build a hosted-checkout URL a buyer can open to pay a merchant.
 * Pure URL construction from ACCESS0X1_WEB_BASE_URL and the rail's `/m/{merchantId}`
 * checkout route; no network call, no funds move. Dormant when no web base is set.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { dormant, ok } from './shared.js';

const DECIMAL_RE = /^\d+$/;

/**
 * Convert a whole-dollar USD amount to the rail's 8-decimal integer string.
 *
 * @param amountUsd The amount in whole dollars.
 * @returns The 8-decimal integer as a decimal string.
 */
function toUsdAmount8(amountUsd: number): string {
  return BigInt(Math.round(amountUsd * 1e8)).toString();
}

/**
 * Register the `checkout_link` tool.
 *
 * @param server The MCP server.
 * @param ctx The shared tool context.
 */
export function registerCheckoutLink(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'checkout_link',
    {
      title: 'Build a checkout link',
      description:
        'Build a hosted-checkout URL for a merchant that a buyer opens to pay — the rail\'s ' +
        '`/m/{merchantId}?amount={usd8}&chainId={id}` route. Optional amountUsd (pre-fills the charge) and ' +
        'chainId (pre-selects the settlement chain). This only constructs a link; it moves no funds. ' +
        'Dormant when ACCESS0X1_WEB_BASE_URL is not set.',
      inputSchema: {
        merchantId: z.string().regex(DECIMAL_RE).describe('Router merchant id as a decimal string'),
        amountUsd: z
          .number()
          .positive()
          .optional()
          .describe('Charge in whole USD to pre-fill; omit to let the buyer choose'),
        chainId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Settlement chain id to pre-select; omit to let the buyer choose'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ merchantId, amountUsd, chainId }) => {
      const base = ctx.config.webBaseUrl;
      if (base === null) {
        return dormant('web', 'set ACCESS0X1_WEB_BASE_URL to build hosted-checkout links');
      }

      const usdAmount8 = amountUsd === undefined ? null : toUsdAmount8(amountUsd);
      const params: string[] = [];
      if (usdAmount8 !== null) {
        params.push(`amount=${encodeURIComponent(usdAmount8)}`);
      }
      if (chainId !== undefined) {
        params.push(`chainId=${encodeURIComponent(String(chainId))}`);
      }
      const query = params.length > 0 ? `?${params.join('&')}` : '';
      const link = `${base}/m/${encodeURIComponent(merchantId)}${query}`;

      return ok(`checkout link: ${link}`, {
        status: 'ok',
        url: link,
        merchantId,
        usdAmount8,
        chainId: chainId ?? null,
        provenance: { source: 'web', baseUrl: base },
      });
    },
  );
}
