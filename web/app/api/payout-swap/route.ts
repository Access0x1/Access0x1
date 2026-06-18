/**
 * POST /api/payout-swap — the OFF-CEI "Receive In Any Coin" payout-swap entrypoint.
 *
 * Runs AFTER settlement is final: the router has already pushed net USDC to the merchant lane (the
 * Solidity money path is DONE). When the merchant's `payoutToken !== USDC`, this swaps the settled
 * USDC into that token on the SAME chain via the chain's configured rail (Uniswap Trading API on
 * Base, Uniswap classic on zkSync, Circle App Kit on Arc). It is purely additive (spec law #5):
 * a failed / skipped / unconfigured swap returns `swapped: false` and the merchant simply keeps the
 * settled USDC — a safe, valid end state. It NEVER calls the router and NEVER blocks settlement.
 *
 * Each rail is env-gated + fail-soft (see deps-from-env): an unconfigured rail yields a non-blocking
 * "not configured" result, never a 500. SECRETS (the Uniswap key, the Blink RPC) are server-only
 * (`runtime = "nodejs"`) and never appear in a response body.
 *
 * INTERNAL endpoint: it is meant to be called by the settlement worker, not the open web. When
 * `PAYOUT_SWAP_INTERNAL_SECRET` is set it is enforced via the `x-internal-secret` header (production
 * default); unset = open (local/demo). Production should also rate-limit it. The swap is always
 * merchant-signed (non-custodial), so even an open call cannot move a third party's funds.
 *
 * Standard Web `Request`/`Response` so it works as a Next.js App Router handler and typechecks
 * without the Next types installed.
 */
import { isAddress, type Address } from "viem";
import { runPayoutSwap, selectPayoutSwapClient } from "../../../lib/payout-swap/index.js";
import { buildPayoutSwapDeps } from "../../../lib/payout-swap/deps-from-env.js";
import type { PayoutSwapResult, SwapRequest } from "../../../lib/payout-swap/types.js";

/** Force Node runtime — deps-from-env reads server-only secrets (Uniswap key, Blink RPC). */
export const runtime = "nodejs";

interface PayoutSwapBody {
  /** Chain the settled USDC sits on (same-chain swap, not a bridge). */
  chainId?: number;
  /** Settled-USDC token address (input). */
  usdc?: string;
  /** Merchant's configured payout token (output). */
  payoutToken?: string;
  /** Merchant wallet that holds the USDC and signs the swap (non-custodial). */
  merchant?: string;
  /** Settled USDC to swap, base-unit integer STRING (atomic; no floats over the wire). */
  amountUsdc?: string;
  /** Slippage floor in payoutToken base units, integer STRING. */
  minAmountOut?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** PayoutSwapResult carries a bigint `amountOut`; stringify it for the wire (omit when absent). */
function serialize(r: PayoutSwapResult): Record<string, unknown> {
  return { ...r, amountOut: r.amountOut === undefined ? undefined : r.amountOut.toString() };
}

/** Parse a non-negative base-unit integer string into a bigint, or null when malformed. */
function parseBaseUnits(v: string | undefined): bigint | null {
  if (typeof v !== "string" || !/^\d+$/.test(v.trim())) return null;
  try {
    return BigInt(v.trim());
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  // Internal guard (env-gated): enforce only when a secret is configured (production default).
  const internalSecret = (process.env.PAYOUT_SWAP_INTERNAL_SECRET ?? "").trim();
  if (internalSecret) {
    const provided = request.headers.get("x-internal-secret") ?? "";
    if (provided !== internalSecret) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  let body: PayoutSwapBody;
  try {
    body = (await request.json()) as PayoutSwapBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (typeof body.chainId !== "number" || !Number.isInteger(body.chainId)) {
    return json({ error: "chainId (integer) is required" }, 400);
  }
  if (!body.usdc || !isAddress(body.usdc)) return json({ error: "usdc must be a valid address" }, 400);
  if (!body.payoutToken || !isAddress(body.payoutToken)) {
    return json({ error: "payoutToken must be a valid address" }, 400);
  }
  if (!body.merchant || !isAddress(body.merchant)) {
    return json({ error: "merchant must be a valid address" }, 400);
  }
  const amountUsdc = parseBaseUnits(body.amountUsdc);
  const minAmountOut = parseBaseUnits(body.minAmountOut);
  if (amountUsdc === null) return json({ error: "amountUsdc must be a base-unit integer string" }, 400);
  if (minAmountOut === null) return json({ error: "minAmountOut must be a base-unit integer string" }, 400);

  const req: SwapRequest = {
    chainId: body.chainId,
    usdc: body.usdc as Address,
    payoutToken: body.payoutToken as Address,
    merchant: body.merchant as Address,
    amountUsdc,
    minAmountOut,
  };

  // Build the configured rails from server env (fail-soft per rail).
  const deps = buildPayoutSwapDeps();

  let client;
  try {
    client = selectPayoutSwapClient(req.chainId, deps);
  } catch (err) {
    // The chain HAS a rail, but its env is not configured on this server — dormant, not an error.
    const detail = err instanceof Error ? err.message : "rail not configured";
    return json(serialize({ swapped: false, reason: "chain-not-capable", detail }));
  }
  if (!client) {
    // No same-chain rail for this chain — the worker would no-op anyway; short-circuit clearly.
    return json(
      serialize({
        swapped: false,
        reason: "chain-not-capable",
        detail: `chain ${req.chainId} has no same-chain payout-swap rail`,
      }),
    );
  }

  // The worker never throws — every failure is carried in the result (law #5).
  const result = await runPayoutSwap(req, client);
  return json(serialize(result));
}
