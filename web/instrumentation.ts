/**
 * @file instrumentation.ts — Next.js server-boot hook (runs once per server
 * start, before any request). The ONE production caller that wires the agent's
 * Dynamic MPC wallet + x402 paying fetch (lib/agent/dynamicBoot.ts) into the
 * throw-by-default seams. Guarded to the Node.js runtime and dynamically
 * imported so the node SDK never reaches an edge or client bundle.
 *
 * Fail-soft: wireAgentRuntime logs-and-continues on error, so a missing or
 * broken SDK leaves the agent routes in their honest unwired state without
 * crashing the server.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { wireAgentRuntime } = await import("./lib/agent/dynamicBoot.js");
    wireAgentRuntime();
  }
}
