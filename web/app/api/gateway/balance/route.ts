/**
 * GET /api/gateway/balance — the seller's Gateway available balance + wallet USDC.
 *
 * Both values are returned as 6-decimal USDC strings. The Circle balances API may
 * return amounts as a DECIMAL string ("5.00") or as ATOMIC base units ("5000000");
 * this route normalizes both to a canonical "5.000000".
 *
 * Doctrine law #5: a balance read is INFORMATIONAL, not settlement — any error
 * returns a zero balance, never a 500 that breaks the dashboard.
 */
import {
  ARC_TESTNET_GATEWAY_DOMAIN,
  ARC_TESTNET_NETWORK,
  GATEWAY_BALANCES_API,
} from "@/lib/arc-constants.js";

/** Canonical zero balance, returned on any read error. */
const ZERO = "0.000000";

/**
 * Normalize a Circle balance value to a 6-decimal USDC string.
 *
 * Heuristic: a value containing "." is already decimal USDC; a bare integer is
 * atomic base units (6 decimals) and is divided by 1e6.
 *
 * @param raw - the value from the Circle API (decimal or atomic string/number)
 * @returns a 6-decimal USDC string, or {@link ZERO} if unparseable
 */
export function normalizeUsdc(raw: unknown): string {
  if (raw === null || raw === undefined) return ZERO;
  const s = String(raw).trim();
  if (s === "") return ZERO;

  if (s.includes(".")) {
    const n = Number(s);
    return Number.isFinite(n) ? n.toFixed(6) : ZERO;
  }

  // Bare integer → atomic base units (6 decimals).
  let atomic: bigint;
  try {
    atomic = BigInt(s);
  } catch {
    return ZERO;
  }
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

/**
 * Read the seller's Gateway available balance and wallet USDC.
 *
 * @returns 200 { gateway, wallet } as decimal USDC (zero fallback on any READ
 *   error, per law #5); 503 { ok:false, reason:"not_configured" } when the
 *   deployment has no SELLER_ADDRESS — unconfigured is a state, not a fault,
 *   so it must be neither a 500 (reads as a broken server) nor a 200 zero
 *   (reads as a real empty balance).
 */
export async function GET(): Promise<Response> {
  const seller = process.env.SELLER_ADDRESS;
  if (!seller || seller.trim() === "") {
    // Honest-dormant: 503 + typed body. Every consumer's `!res.ok → hide`
    // handling keeps working (GatewayBalanceCard hides itself rather than
    // rendering a confident wrong zero), while no monitor mistakes
    // "not configured yet" for a server fault the way the old 500 did.
    return Response.json(
      { ok: false, reason: "not_configured", error: "SELLER_ADDRESS is not set." },
      { status: 503 },
    );
  }

  try {
    const url = `${GATEWAY_BALANCES_API}?domain=${ARC_TESTNET_GATEWAY_DOMAIN}&address=${seller}&network=${ARC_TESTNET_NETWORK}`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return Response.json({ gateway: ZERO, wallet: ZERO });
    }
    const body = (await res.json()) as {
      gateway?: { available?: unknown };
      available?: unknown;
      wallet?: { balance?: unknown };
      balance?: unknown;
    };
    const gatewayRaw = body?.gateway?.available ?? body?.available;
    const walletRaw = body?.wallet?.balance ?? body?.balance;
    return Response.json({
      gateway: normalizeUsdc(gatewayRaw),
      wallet: normalizeUsdc(walletRaw),
    });
  } catch {
    // Informational read — never 500 the dashboard (law #5).
    return Response.json({ gateway: ZERO, wallet: ZERO });
  }
}
