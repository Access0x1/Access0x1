// pay.mjs — buy one coffee, USD-priced, in a single on-chain transaction.
//
// Flow: quote $4.50 → token amount (via the router's Chainlink feed, in-tx) → approve the router
// to pull exactly that USDC → payToken → buyer pays, merchant gets net, treasury gets the fee, all
// in the SAME block. The router holds nothing: its balance is ~0 after the settlement (zero custody).
//
// Run:  RPC_URL=<base-sepolia-rpc>  PRIVATE_KEY=<funded dev key>  node pay.mjs
//   - PRIVATE_KEY must be a FRESH testnet dev wallet — never a key that holds real value.
//   - MERCHANT_ID defaults to a placeholder; set it to a merchant you registered (see README).
//
// Deps: `npm i viem` (or run from a repo checkout — viem is already a workspace dep).

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseUnits,
  formatUnits,
  erc20Abi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── Live testnet addresses — the CREATE3 mirror set, identical on every mirrored chain. ──
// Source of truth: README "Deployments" table. Re-confirm on the explorer before real value.
const ROUTER = '0xe92244e3368561faf21648146511DeDE3a475EB5';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Circle USDC on Base Sepolia (6 decimals)

// ── What you're buying ──
const MERCHANT_ID = BigInt(process.env.MERCHANT_ID ?? '1'); // your registered merchantId
const PRICE_USD = '4.50'; // one coffee
const ORDER_ID = 'order-coffee-0001';

// USD-8 fixed point: the router prices in USD with 8 decimals. $4.50 -> 450_000_000.
const usdAmount8 = parseUnits(PRICE_USD, 8);
// orderId is a bytes32 the router echoes in its PaymentReceived event for reconciliation.
const orderId = ('0x' + Buffer.from(ORDER_ID).toString('hex').padEnd(64, '0')).slice(0, 66);

// Minimal ABI — only the two router functions this script calls.
const routerAbi = [
  {
    type: 'function',
    name: 'quote',
    stateMutability: 'view',
    inputs: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'usdAmount8', type: 'uint256' },
    ],
    outputs: [{ name: 'tokenAmount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'payToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'usdAmount8', type: 'uint256' },
      { name: 'orderId', type: 'bytes32' },
    ],
    outputs: [],
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

  // 1. QUOTE — ask the router what $4.50 costs in USDC right now (Chainlink feed, read on-chain).
  const gross = await publicClient.readContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'quote',
    args: [MERCHANT_ID, USDC, usdAmount8],
  });
  console.log(`$${PRICE_USD} = ${formatUnits(gross, 6)} USDC (gross the router will pull)`);

  // 2. APPROVE — let the router pull exactly `gross`. The router pulls THE FULL AMOUNT or reverts
  //    (its balance-delta check rejects fee-on-transfer tokens), so an exact approval is safe.
  const approveHash = await walletClient.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [ROUTER, gross],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // 3. PAY — one tx: pull gross, split the fee, push net→merchant + fee→treasury, emit the receipt.
  const payHash = await walletClient.writeContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'payToken',
    args: [MERCHANT_ID, USDC, usdAmount8, orderId],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: payHash });

  console.log(`Paid. tx ${receipt.transactionHash} (block ${receipt.blockNumber})`);
  console.log('net + fee == gross, settled in one block — the router kept nothing.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
