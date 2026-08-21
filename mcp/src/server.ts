/**
 * server.ts — assemble the MCP server and register the rail tools. Kept separate
 * from the process entrypoint so tests can build a server against an in-memory
 * context without touching stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import type { ToolContext } from './context.js';
import { registerAllTools } from './tools/index.js';

/**
 * Build a fully-wired MCP server for the given context.
 *
 * @param ctx The shared tool context (config + loaded manifest + I/O seams).
 * @returns The server, ready to `connect(transport)`.
 */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools to operate the Access0x1 payments rail. Chain addresses come from the rail manifest at ' +
        'runtime — call list_chains, then chain_facts(chainId), and never assume an address from memory. ' +
        'Indexed reads (merchant_lookup, merchant_payments, network_leaderboard, verify_payment) surface ' +
        '"as of block N" and an indexer-health flag; trust a verdict only when the index is healthy and ' +
        'degrade conservatively otherwise. checkout_link builds a buyer link; agent_pay_request forwards ' +
        'to the rail\'s own budgeted pay route (this server holds no keys).',
    },
  );
  registerAllTools(server, ctx);
  return server;
}
