// subscribe.mjs — subscribe to a "Pro" tier, sign-once then auto-renew, via SessionGrant.
//
// The idea: a subscription IS a budget-scoped SessionGrant. The subscriber opens ONE session that
// authorizes the Access0x1Subscriptions contract to spend up to a budget cap until an expiry; after
// that, every `renew` debits the budget and pulls the period charge through the router fee-split —
// with NO further wallet prompt. SessionGrant never holds funds; it is a pure authorization ledger.
//
// Flow:
//   1. (merchant, once)  setPlan(merchantId, planKey, priceUsd8, periodSecs, active)
//   2. (subscriber)      approve USDC to the router   (the contract pulls the charge through it)
//   3. (subscriber)      openSession(SUBSCRIPTIONS, budgetCap, expiry)  -> sessionId   ← sign once
//   4. (subscriber)      subscribe(merchantId, planKey, USDC, sessionId, withTrial=false)
//   5. (anyone/keeper)   renew(subId)  when the period is due — no co-sign, debits the budget
//
// Run:  RPC_URL=<base-sepolia-rpc>  PRIVATE_KEY=<funded dev key>  node subscribe.mjs
//   PRIVATE_KEY = a FRESH testnet dev wallet, never a key with real value.
//
// Deps: `npm i viem`.

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseUnits,
  erc20Abi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── Live testnet addresses — CREATE3 mirror set (README "Deployments"). Re-confirm on the explorer. ──
const ROUTER = '0xe92244e3368561faf21648146511DeDE3a475EB5';
const SUBSCRIPTIONS = '0x787D2d97F7b0B0A7aFE1eCD97032912fefE8e0ba';
const SESSION_GRANT = '0xf84fEA541939f3683893530101Fe77d05c390C9d';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia, 6 decimals

// ── The plan ──
const MERCHANT_ID = BigInt(process.env.MERCHANT_ID ?? '1');
const PLAN_KEY = 0; // uint8 — which plan on this merchant (set with setPlan)
const PRICE_USD = '29.00'; // "Pro" tier, per period
const BUDGET_USD = '120.00'; // session cap — covers ~4 renewals before re-authorizing

const priceUsd8 = parseUnits(PRICE_USD, 8); // USD-8 fixed point: $29.00 -> 2_900_000_000
const budgetUsd8 = parseUnits(BUDGET_USD, 8);
const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60); // 1 year out

const sessionGrantAbi = [
  {
    type: 'function',
    name: 'openSession',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'delegate', type: 'address' },
      { name: 'budgetCap', type: 'uint256' },
      { name: 'expiry', type: 'uint64' },
    ],
    outputs: [{ name: 'sessionId', type: 'bytes32' }],
  },
];

const subscriptionsAbi = [
  {
    type: 'function',
    name: 'subscribe',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'planKey', type: 'uint8' },
      { name: 'token', type: 'address' },
      { name: 'sessionId', type: 'bytes32' },
      { name: 'withTrial', type: 'bool' },
    ],
    outputs: [{ name: 'subId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'renew',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'subId', type: 'uint256' }],
    outputs: [{ name: 'chargedToken', type: 'uint256' }],
  },
];

const baseSepolia = defineChain({
  id: 84532,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://sepolia.base.org'] } },
  testnet: true,
});

async function main() {
  const key = process.env.PRIVATE_KEY;
  if (!key) throw new Error('Set PRIVATE_KEY to a funded testnet dev wallet (never a real key).');

  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });

  // Pre-req: the merchant has already defined this plan via setPlan(merchantId, planKey, priceUsd8,
  // periodSecs, active). This script is the SUBSCRIBER side.

  // 1. APPROVE the router to pull the period charge (a generous allowance covering the budget cap).
  const approveHash = await walletClient.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [ROUTER, parseUnits(BUDGET_USD, 6)], // USDC has 6 decimals
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // 2. SIGN ONCE — open a budget-scoped session naming the Subscriptions contract as the delegate.
  //    This is the ONLY wallet prompt for the whole billing relationship.
  const { request: openReq, result: sessionId } = await publicClient.simulateContract({
    account,
    address: SESSION_GRANT,
    abi: sessionGrantAbi,
    functionName: 'openSession',
    args: [SUBSCRIPTIONS, budgetUsd8, expiry],
  });
  await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract(openReq) });
  console.log(`Session opened: ${sessionId} (cap $${BUDGET_USD}, delegate = Subscriptions)`);

  // 3. SUBSCRIBE — period 1 charges immediately through the router fee-split (withTrial=false).
  const { request: subReq, result: subId } = await publicClient.simulateContract({
    account,
    address: SUBSCRIPTIONS,
    abi: subscriptionsAbi,
    functionName: 'subscribe',
    args: [MERCHANT_ID, PLAN_KEY, USDC, sessionId, false],
  });
  await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract(subReq) });
  console.log(`Subscribed. subId = ${subId} — $${PRICE_USD}/period charged.`);

  // 4. RENEW — when the period is due, ANYONE (a keeper, the AutomationGateway, you) can call renew.
  //    It debits the session budget and pulls the next charge — no subscriber co-sign. It reverts if
  //    the period isn't due yet, so it's safe to poll. Shown here for completeness:
  //
  //    await walletClient.writeContract({
  //      address: SUBSCRIPTIONS, abi: subscriptionsAbi, functionName: 'renew', args: [subId],
  //    });
  console.log('Future renewals: renew(subId) — debits the budget, no further wallet prompt.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
