/**
 * GET /api/premium/quote — a $0.001 x402-priced endpoint.
 *
 * Served IFF Circle settles the payer's EIP-3009 micro-authorization. Real
 * (sub-cent) USDC on Arc Testnet; no separate gas step at the batch layer.
 */
import { withGateway } from "@/lib/x402.js";

const CATEGORIES = ["markets", "weather", "sports", "trivia"] as const;

const QUOTES = [
  "Compounding is the eighth wonder of the world.",
  "Time in the market beats timing the market.",
  "Risk comes from not knowing what you are doing.",
  "The best time to plant a tree was twenty years ago.",
] as const;

/**
 * Return a single quote with a category and timestamp.
 *
 * @returns 200 { quote, category, timestamp }
 */
async function handler(): Promise<Response> {
  const i = Math.floor(Math.random() * QUOTES.length);
  const c = Math.floor(Math.random() * CATEGORIES.length);
  return Response.json({
    quote: QUOTES[i],
    category: CATEGORIES[c],
    timestamp: Date.now(),
  });
}

export const GET = withGateway(handler, "$0.001", "/api/premium/quote");
