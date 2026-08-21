/**
 * agent_pay_request — shape and POST the rail's budget-scoped agent-pay contract
 * (`POST /api/agent/pay`). This server holds NO keys and NO wallet: the web route
 * owns the signer, the spend meter, the URL allowlist, and the caller-auth gate.
 * This tool only forms a valid request and forwards the route's own structured
 * response. Dormant when no web base is set.
 *
 * The route pays an x402 resource `url` up to a per-call USD cap, optionally
 * pre-checking a merchant's indexed state. The optional caller-auth token
 * (ACCESS0X1_AGENT_INTERNAL_SECRET) is forwarded as the route's `x-internal-secret`
 * header when present; it is never echoed back in the result.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { dormant, failure, ok } from './shared.js';

const DECIMAL_RE = /^\d+$/;
const MAX_COUNT = 50;

/**
 * Register the `agent_pay_request` tool.
 *
 * @param server The MCP server.
 * @param ctx The shared tool context.
 */
export function registerAgentPayRequest(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'agent_pay_request',
    {
      title: 'Request an agent payment',
      description:
        'Ask the rail to make a budget-scoped autonomous payment for an x402 resource, via its ' +
        '`POST /api/agent/pay` route. Supply the resource URL, a per-call USD cap (usdAmount), and the ' +
        'merchant id to associate. This server holds no keys — the web route owns the wallet, the spend ' +
        'meter, the URL allowlist, and caller-auth — and this tool forwards the route\'s own response ' +
        'verbatim. Dormant when ACCESS0X1_WEB_BASE_URL is not set.',
      inputSchema: {
        merchantId: z.string().regex(DECIMAL_RE).describe('Router merchant id as a decimal string'),
        usdAmount: z.number().positive().describe('Per-call spend cap in USD (the route enforces the budget)'),
        resourceUrl: z
          .string()
          .url()
          .describe('The x402 resource URL to pay (the route enforces its own allowlist)'),
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_COUNT)
          .optional()
          .describe(`Number of calls for a nano-loop (1–${MAX_COUNT}; default 1)`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ merchantId, usdAmount, resourceUrl, count }) => {
      const base = ctx.config.webBaseUrl;
      if (base === null) {
        return dormant('web', 'set ACCESS0X1_WEB_BASE_URL to reach the agent-pay route');
      }

      const endpoint = `${base}/api/agent/pay`;
      const body: Record<string, unknown> = {
        url: resourceUrl,
        pricePerCallUsd: usdAmount,
        merchantId,
      };
      if (count !== undefined && count > 1) {
        body.count = count;
      }

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (ctx.config.agentInternalSecret !== null) {
        // Forward the caller-auth token the route checks. Never logged, never echoed.
        headers['x-internal-secret'] = ctx.config.agentInternalSecret;
      }

      let httpStatus: number;
      let parsed: unknown;
      try {
        const res = await ctx.fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
        httpStatus = res.status;
        const text = await res.text();
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      } catch (err) {
        return failure(`could not reach the agent-pay route: ${err instanceof Error ? err.message : String(err)}`);
      }

      const accepted = httpStatus >= 200 && httpStatus < 300;
      return ok(
        `agent-pay route responded ${httpStatus}${accepted ? ' (accepted)' : ' (declined)'}`,
        {
          status: 'ok',
          accepted,
          httpStatus,
          request: { endpoint, merchantId, usdAmount, resourceUrl, count: count ?? 1 },
          response: parsed,
          provenance: { source: 'web', baseUrl: base },
        },
      );
    },
  );
}
