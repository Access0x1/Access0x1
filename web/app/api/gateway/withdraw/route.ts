/**
 * POST /api/gateway/withdraw — the WITHDRAW-leg handoff seam (STUB in this unit).
 *
 * Validates the request, pre-checks the seller's available Gateway balance BEFORE
 * signing (off-CEI — no signed tx without a balance check), calls
 * `gateway.withdraw(amount, { chain, recipient })`, and returns the `mintTxHash`.
 *
 * Full wiring to `Access0x1Router.payToken` + Unlink `depositWithApproval` (the
 * private withdrawal) is `feat/unlink-private`. This file is the agreed handoff
 * point that unit consumes.
 *
 * Doctrine:
 *  - caller auth (guardrail #0): the caller MUST present a Dynamic JWT verified
 *    against the issuer's JWKS via `resolveVerifiedTenant`. The verified wallet
 *    MUST equal SELLER_ADDRESS. An anonymous caller, or any wallet other than the
 *    seller's, receives 401 — the withdrawal NEVER proceeds.
 *  - zero custody (guardrail #1): the balance belongs to SELLER_ADDRESS.
 *  - law #5 (money paths never swallow): a gas error is TRANSLATED to a friendly
 *    message and returned as 400/502 — never swallowed, never re-thrown raw.
 *  - off-CEI (guardrail #5): auth + validate + balance pre-check BEFORE the signed tx.
 */
import { GATEWAY_DOMAINS, GatewayClient } from "@circle-fin/x402-batching/client";
import type { SupportedChainName } from "@circle-fin/x402-batching/client";
import type { Hex } from "viem";

import {
  resolveVerifiedTenant,
  TenantAuthError,
} from "@/lib/branding/tenant.js";

import { ARC_TESTNET_GATEWAY_CHAIN, ARC_TESTNET_RPC } from "@/lib/arc-constants.js";

/** The withdraw client surface this route needs (injectable for tests). */
export type WithdrawClient = {
  getBalances: () => Promise<{ gateway: { formattedAvailable: string } }>;
  withdraw: (
    amount: string,
    options: { chain: SupportedChainName; recipient: Hex },
  ) => Promise<{ mintTxHash: string }>;
};

/** Request body for a withdrawal. */
type WithdrawBody = {
  amount?: unknown;
  destinationChain?: unknown;
  recipient?: unknown;
};

/**
 * Build the real GatewayClient from the server-only SELLER_PRIVATE_KEY.
 *
 * @returns a {@link WithdrawClient} backed by the live Circle SDK on Arc Testnet
 * @throws if SELLER_PRIVATE_KEY is unset
 */
function defaultClientFactory(): WithdrawClient {
  const key = process.env.SELLER_PRIVATE_KEY;
  if (!key || key.trim() === "") {
    throw new Error("SELLER_PRIVATE_KEY is not set.");
  }
  return new GatewayClient({
    chain: ARC_TESTNET_GATEWAY_CHAIN,
    privateKey: key as Hex,
    rpcUrl: ARC_TESTNET_RPC,
  }) as unknown as WithdrawClient;
}

/** Pluggable client factory (overridable in tests). */
let clientFactory: () => WithdrawClient = defaultClientFactory;

/** Test-only: override the GatewayClient factory. */
export function __setWithdrawClientFactory(
  factory: (() => WithdrawClient) | null,
): void {
  clientFactory = factory ?? defaultClientFactory;
}

/** Translate a raw SDK error into a user-facing message (never swallowed). */
function translateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient funds for gas|out of gas|gas required exceeds/i.test(msg)) {
    return "Not enough USDC to cover Arc gas for the withdrawal. Top up the payout wallet and retry.";
  }
  if (/insufficient/i.test(msg)) {
    return "Insufficient Gateway balance for this withdrawal.";
  }
  return msg;
}

/**
 * Withdraw accrued USDC from the seller's Gateway Balance.
 *
 * Auth: requires a Dynamic JWT in `Authorization: Bearer <token>`. The verified
 * wallet MUST equal SELLER_ADDRESS (only the seller may withdraw their own
 * balance). Missing/invalid token → 401. Wrong wallet → 403.
 *
 * @param req - body: { amount: decimal string, destinationChain: chain key, recipient: address }
 * @returns 200 { mintTxHash } on success; 400 on validation / balance failure;
 *          401/403 on auth failure; 502 on an upstream gateway error
 */
export async function POST(req: Request): Promise<Response> {
  // ── Auth: verify the caller IS the seller BEFORE reading the body ────────────
  // Clone the request so the body stream can be read again below.
  const reqForAuth = req.clone();
  let authBody: unknown;
  try {
    authBody = await reqForAuth.json();
  } catch {
    authBody = {};
  }

  let callerWallet: string;
  try {
    const resolved = await resolveVerifiedTenant(req, authBody);
    // FAIL CLOSED on this money path. resolveVerifiedTenant returns
    // { verified:false } — trusting the body-supplied tenantId — whenever Dynamic
    // JWT verification is not configured (NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID unset).
    // SELLER_ADDRESS is public (it is the payTo in every 402 challenge), so without
    // this guard an attacker could POST { tenantId: <seller>, recipient: <attacker> }
    // with no token, match the seller check below, and drain the Gateway balance.
    // A withdrawal signed with SELLER_PRIVATE_KEY must never accept an unverified,
    // body-asserted identity — require a cryptographically verified caller.
    if (!resolved.verified) {
      return Response.json(
        { error: "unauthorized: withdrawal requires a verified Dynamic session" },
        { status: 401 },
      );
    }
    callerWallet = resolved.tenantId;
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return Response.json({ error: err.message }, { status: 401 });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const sellerAddress = (process.env.SELLER_ADDRESS ?? "").trim().toLowerCase();
  if (!sellerAddress) {
    return Response.json(
      { error: "SELLER_ADDRESS is not configured on this server." },
      { status: 500 },
    );
  }
  if (callerWallet !== sellerAddress) {
    return Response.json(
      { error: "forbidden: caller wallet does not match the seller address" },
      { status: 403 },
    );
  }

  // ── Body parsing (already parsed above for auth; reuse the same object) ──────
  const body = authBody as WithdrawBody;

  const amount = typeof body.amount === "string" ? body.amount.trim() : "";
  const destinationChain =
    typeof body.destinationChain === "string" ? body.destinationChain : "";
  const recipient = typeof body.recipient === "string" ? body.recipient : "";

  const amountNum = Number(amount);
  if (!amount || !Number.isFinite(amountNum) || amountNum <= 0) {
    return Response.json({ error: "invalid amount" }, { status: 400 });
  }

  if (!(destinationChain in GATEWAY_DOMAINS)) {
    return Response.json({ error: "unsupported chain" }, { status: 400 });
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return Response.json({ error: "invalid recipient" }, { status: 400 });
  }

  let client: WithdrawClient;
  try {
    client = clientFactory();
  } catch (err) {
    return Response.json({ error: translateError(err) }, { status: 502 });
  }

  // Off-CEI: balance pre-check BEFORE any signed transaction.
  try {
    const balances = await client.getBalances();
    const available = Number(balances.gateway.formattedAvailable);
    if (!Number.isFinite(available) || available < amountNum) {
      return Response.json(
        { error: "insufficient balance" },
        { status: 400 },
      );
    }
  } catch (err) {
    return Response.json({ error: translateError(err) }, { status: 502 });
  }

  // Execute the withdrawal. A gas error is translated, never swallowed (law #5).
  try {
    const result = await client.withdraw(amount, {
      chain: destinationChain as SupportedChainName,
      recipient: recipient as Hex,
    });
    return Response.json({ mintTxHash: result.mintTxHash });
  } catch (err) {
    const friendly = translateError(err);
    // A gas/balance problem is a client-correctable 400; anything else is 502.
    const status = /USDC to cover Arc gas|Insufficient Gateway/i.test(friendly)
      ? 400
      : 502;
    return Response.json({ error: friendly }, { status });
  }
}
