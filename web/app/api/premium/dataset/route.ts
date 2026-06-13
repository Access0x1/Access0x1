/**
 * GET /api/premium/dataset — a $0.01 x402-priced endpoint.
 *
 * Served IFF Circle settles the payer's EIP-3009 micro-authorization.
 */
import { withGateway } from "@/lib/x402.js";

/**
 * Return a small synthetic dataset with a generation timestamp.
 *
 * @returns 200 { dataset, generated_at }
 */
async function handler(): Promise<Response> {
  const dataset = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    symbol: ["BTC", "ETH", "USDC", "SOL", "ARB"][i],
    score: Math.round(Math.random() * 1000) / 10,
  }));
  return Response.json({
    dataset,
    generated_at: new Date().toISOString(),
  });
}

export const GET = withGateway(handler, "$0.01", "/api/premium/dataset");
