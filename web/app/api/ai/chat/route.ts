/**
 * @file route.ts — POST /api/ai/chat: the "connect an AI API" endpoint.
 *
 * This is the first-class, connectable surface: an AI agent (or an MCP client)
 * presents an Access0x1 API key, the call is metered against that key's
 * SessionGrant budget, paid per-use via x402 on Arc Testnet, and ONLY THEN does
 * the handler run an upstream AI completion and return it.
 *
 * THE FLOW (all enforced by `withAiGateway`, see `lib/ai/aiGateway.ts`):
 *   Authorization: Bearer ak_…   →  resolves to a SessionGrant session + price
 *   reserve price on the session  →  402 SessionBudgetExceeded if over budget
 *   x402 challenge + Circle settle →  the agent's wallet pays per call in USDC,
 *                                     Arc's native gas token
 *   settle succeeded              →  THIS handler runs the upstream completion
 *
 * So a developer "connects their AI API" by: (1) opening a SessionGrant budget,
 * (2) getting an `ak_…` key bound to it, (3) pointing their agent at this URL with
 * that key. Every request is budget-capped and pay-per-call with no custom
 * contract code — it composes the existing rail.
 *
 * THE UPSTREAM AI (the honest boundary — law #4). After settlement this handler
 * calls a REAL model: the Anthropic SDK already shipped in this repo (the same
 * `CLAUDE_API_KEY` server env as `/api/ask`). When that key is NOT configured the
 * handler does NOT fake a completion — it returns a clear `not_configured` 503 so
 * the metering/payment rail is still demonstrable end-to-end while the upstream is
 * truthfully absent. The x402 payment is real on Arc Testnet regardless; only the
 * AI body degrades, and it says so.
 *
 * Server-only: `CLAUDE_API_KEY` is read from server env, never returned, never
 * logged, never bundled (next.config marks `@anthropic-ai/sdk` external).
 */

import Anthropic from "@anthropic-ai/sdk";
import { withAiGateway } from "@/lib/ai/aiGateway.js";

export const dynamic = "force-dynamic";

/** Per-call price: BOTH the SessionGrant reservation and the x402 settle amount. */
const PRICE = "$0.001";

/** The model this metered endpoint serves. Haiku — cheap, matches `/api/ask`. */
const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 512;
const MAX_PROMPT_LEN = 4000;

/** Small JSON helper — never leaks internals (guardrail #7). */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The post-settlement AI handler. Reads `{ prompt }` from the body AFTER the
 * gateway has authenticated the key, reserved the budget, and settled the payment,
 * then returns an upstream completion.
 *
 * @param req The request; its JSON body is `{ prompt: string }`, read post-settle.
 * @returns 200 { model, completion, paid } on success;
 *          400 on a bad/oversized prompt;
 *          503 { code: "not_configured" } when no upstream AI key is set (honest
 *              degrade — the payment rail still ran);
 *          502 on an upstream AI error.
 */
async function handler(req: Request): Promise<Response> {
  let prompt = "";
  try {
    const body = (await req.json()) as { prompt?: unknown };
    prompt = typeof body?.prompt === "string" ? body.prompt : "";
  } catch {
    return json({ error: "BadRequest", reason: "invalid JSON body" }, 400);
  }
  if (prompt.trim().length === 0) {
    return json({ error: "BadRequest", reason: 'missing "prompt"' }, 400);
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    return json({ error: "BadRequest", reason: `prompt too long (max ${MAX_PROMPT_LEN})` }, 400);
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    // Honest degrade: the payment already settled (the gateway ran THIS handler
    // only on a successful settle), but the upstream AI is not wired on this
    // deployment. Say so plainly — never fabricate a completion (law #4).
    return json(
      {
        error: "Upstream AI is not configured on this deployment.",
        code: "not_configured",
        note: "The x402 payment settled; configure CLAUDE_API_KEY to serve completions.",
      },
      503,
    );
  }

  const client = new Anthropic({ apiKey });
  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
    const completion = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return json({ model: MODEL, completion, paid: PRICE }, 200);
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? (err.status ?? 502) : 502;
    return json({ error: "Upstream AI request failed.", code: "upstream_error" }, status);
  }
}

/**
 * The connectable endpoint: API-key-authed, SessionGrant-metered, x402-paid.
 * `withAiGateway` enforces every layer before `handler` ever runs.
 */
export const POST = withAiGateway(handler, PRICE, "/api/ai/chat");
