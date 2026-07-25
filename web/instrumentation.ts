/**
 * @file instrumentation.ts — Next.js server-boot hook (runs once per server
 * start, before any request). The ONE production caller that wires the agent's
 * Dynamic MPC wallet + x402 paying fetch (lib/agent/dynamicBoot.ts) into the
 * throw-by-default seams. Guarded to the Node.js runtime and dynamically
 * imported so the node SDK never reaches an edge or client bundle.
 *
 * The import is EXTENSIONLESS on purpose (unlike the app's NodeNext-style
 * `.js` imports): webpack, tsc (moduleResolution: bundler), and vitest all
 * resolve it identically, and it is the one form Turbopack's instrumentation
 * context can also resolve — Turbopack applies no `.js`→`.ts` extension
 * mapping, so the `.js` form kills `next dev` (Turbopack) at boot with
 * MODULE_NOT_FOUND before any route compiles. The chain below it still blocks
 * a full Turbopack port (123 files import NodeNext-style); `next dev
 * --webpack` is the supported dev path (see next.config.ts).
 *
 * Fail-soft: wireAgentRuntime logs-and-continues on error, so a missing or
 * broken SDK leaves the agent routes in their honest unwired state without
 * crashing the server.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { wireAgentRuntime } = await import("./lib/agent/dynamicBoot");
    wireAgentRuntime();
  }
}
