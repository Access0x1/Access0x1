/**
 * Arc Testnet constants for Circle Nanopayments gas-free settlement.
 *
 * Doctrine guardrail #6 — NEVER hardcode Arc addresses at call sites. Every value
 * here is copied VERBATIM from the live `circlefin/arc-nanopayments` repo at the
 * Circle booth. One wrong nibble in the Gateway Wallet address = a silent settle
 * fail. Each value carries a "confirm at booth" note; re-verify before the demo.
 *
 * On Arc, USDC IS the native gas token (system contract `0x3600…0000`), so the
 * Nanopayments batch layer already makes the payer gas-free — no Paymaster.
 *
 * The Arc chain id and RPC URL are NOT re-literalized here: they come from the
 * canonical chain registry in `chains.ts` so they can never drift. Only the
 * Gateway / x402 protocol values (wallet, domain, facilitator) — which are
 * unique to this file — are defined below.
 */

import { ARC_TESTNET_ID, DEFAULT_ARC_RPC_URL } from "./chains.js";

/** CAIP-2 network id for Arc Testnet (chain id 5042002). confirm at booth */
export const ARC_TESTNET_NETWORK = `eip155:${ARC_TESTNET_ID}` as const;

/**
 * Arc Testnet USDC — the Arc system contract. Real USDC, not a mock token
 * (doctrine guardrail #2). confirm at booth
 */
export const ARC_TESTNET_USDC =
  "0x3600000000000000000000000000000000000000" as const;

/**
 * Circle Gateway Wallet on Arc Testnet — the EIP-712 `verifyingContract` the
 * payer signs the EIP-3009 authorization against. confirm at booth
 */
export const ARC_TESTNET_GATEWAY_WALLET =
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

/** Numeric Gateway domain id for the balances API query. confirm at booth */
export const ARC_TESTNET_GATEWAY_DOMAIN = 26;

/** Arc Testnet JSON-RPC endpoint (single source: {@link DEFAULT_ARC_RPC_URL}). */
export const ARC_TESTNET_RPC = DEFAULT_ARC_RPC_URL;

/** Circle Gateway balances API base. confirm at booth */
export const GATEWAY_BALANCES_API =
  "https://gateway-api-testnet.circle.com/v1/balances";

/**
 * Circle Gateway facilitator base URL (testnet). The `BatchFacilitatorClient`
 * posts /v1/x402/{verify,settle} here. confirm at booth
 */
export const ARC_TESTNET_FACILITATOR_URL =
  "https://gateway-api-testnet.circle.com";

/**
 * GatewayClient chain key for Arc Testnet (the SDK's camelCase identifier).
 * NOTE: the Unlink SDK uses the kebab-case `arc-testnet` for the SAME 5042002
 * chain — different identifier, same chain. confirm at booth
 */
export const ARC_TESTNET_GATEWAY_CHAIN = "arcTestnet" as const;
