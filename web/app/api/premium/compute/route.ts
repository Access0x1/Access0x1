/**
 * POST /api/premium/compute — a $0.03 x402-priced endpoint.
 *
 * Reads the request body via `req.json()` AFTER settle succeeds — proving the
 * handler has full post-settle body access. Served IFF Circle settles.
 */
import { withGateway } from "@/lib/x402.js";

/**
 * Echo + transform the POST body after settlement.
 *
 * @param req - the request; its JSON body is read AFTER settle
 * @returns 200 { input, result, computed_at }
 */
async function handler(req: Request): Promise<Response> {
  let input = "";
  try {
    const body = (await req.json()) as { input?: unknown };
    input = typeof body?.input === "string" ? body.input : "";
  } catch {
    input = "";
  }
  const result = input.split("").reverse().join("").toUpperCase();
  return Response.json({
    input,
    result,
    computed_at: new Date().toISOString(),
  });
}

export const POST = withGateway(handler, "$0.03", "/api/premium/compute");
