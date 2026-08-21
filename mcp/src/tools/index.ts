/**
 * tools/index.ts — register every tool on a server in one call.
 *
 * Read tools (never move funds): list_chains, chain_facts, merchant_lookup,
 * merchant_payments, network_leaderboard, verify_payment, checkout_link.
 * Action tool (can move funds via the rail's own budgeted route): agent_pay_request.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { registerListChains } from './listChains.js';
import { registerChainFacts } from './chainFacts.js';
import { registerMerchantLookup } from './merchantLookup.js';
import { registerMerchantPayments } from './merchantPayments.js';
import { registerNetworkLeaderboard } from './networkLeaderboard.js';
import { registerVerifyPayment } from './verifyPayment.js';
import { registerCheckoutLink } from './checkoutLink.js';
import { registerAgentPayRequest } from './agentPayRequest.js';

/**
 * Register all Access0x1 rail tools on the given server.
 *
 * @param server The MCP server.
 * @param ctx The shared tool context.
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // Read tools.
  registerListChains(server, ctx);
  registerChainFacts(server, ctx);
  registerMerchantLookup(server, ctx);
  registerMerchantPayments(server, ctx);
  registerNetworkLeaderboard(server, ctx);
  registerVerifyPayment(server, ctx);
  registerCheckoutLink(server, ctx);
  // Action tool.
  registerAgentPayRequest(server, ctx);
}
