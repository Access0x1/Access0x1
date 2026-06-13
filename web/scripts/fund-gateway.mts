/**
 * fund-gateway.mts — one-time buyer deposit into Circle Gateway on Arc Testnet.
 *
 * Usage:  npx tsx web/scripts/fund-gateway.mts [decimal-amount]
 *
 * Creates a GatewayClient from BUYER_PRIVATE_KEY and deposits a DECIMAL USDC
 * string (e.g. "5.00", NOT base units). The Gateway payer MUST be a plain EOA
 * (the fresh withdrawal target) — never an Unlink execution / ERC-4337 account
 * (NANOPAYMENTS §3b buyer-side rule).
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import type { Hex } from "viem";

import {
  ARC_TESTNET_GATEWAY_CHAIN,
  ARC_TESTNET_RPC,
} from "../lib/arc-constants.js";

/** Default deposit if no amount argument is supplied (decimal USDC). */
const DEFAULT_DEPOSIT = "5.00";

/**
 * Deposit USDC into the Gateway for the buyer EOA.
 *
 * @param amount - decimal USDC string, e.g. "5.00"
 * @returns the deposit + post-deposit available balance, for logging
 */
async function fundGateway(amount: string): Promise<void> {
  const key = process.env.BUYER_PRIVATE_KEY;
  if (!key || key.trim() === "") {
    throw new Error("BUYER_PRIVATE_KEY is not set.");
  }
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL ?? ARC_TESTNET_RPC;

  const gateway = new GatewayClient({
    chain: ARC_TESTNET_GATEWAY_CHAIN,
    privateKey: key as Hex,
    rpcUrl,
  });

  console.log(`Depositing ${amount} USDC into Gateway as ${gateway.address}…`);
  const deposit = await gateway.deposit(amount);
  console.log(`  deposit tx: ${deposit.depositTxHash}`);

  const balances = await gateway.getBalances();
  console.log(
    `  Gateway available: ${balances.gateway.formattedAvailable} USDC`,
  );
}

const amountArg = process.argv[2] ?? DEFAULT_DEPOSIT;
fundGateway(amountArg).catch((err) => {
  console.error("fund-gateway failed:", err);
  process.exitCode = 1;
});
