// list-and-buy.mjs — list an ERC-721 at a USD price and buy it atomically through Access0x1Nft.
//
// Access0x1Nft is a zero-custody NFT marketplace primitive: a seller lists an ERC-721 at a USD price;
// a buyer pays an allowlisted token and the NFT transfers IN THE SAME TX as the payment. The router
// (payToken) does all pricing + fee-split; Access0x1Nft never holds a payment token — it only escrows
// the listed NFT between `list` and `buy`/`cancelListing`. If the NFT leg fails, the money rolls back.
//
// Flow:
//   SELLER:  approve(Access0x1Nft, tokenId)  → list(merchantId, collection, tokenId, USDC, priceUsd8)
//   BUYER:   quote → approve(router, gross)  → buy(listingId, priceUsd8, maxTokenAmount)
//
// This script can run either side. Set ROLE=seller (default) or ROLE=buyer.
//
// Run:  RPC_URL=<base-sepolia-rpc>  PRIVATE_KEY=<funded dev key>  ROLE=seller  node list-and-buy.mjs
//   PRIVATE_KEY = a FRESH testnet dev wallet, never a key with real value.
//
// Deps: `npm i viem`.

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

// ── Live testnet addresses — CREATE3 mirror set (README "Deployments"). Re-confirm on the explorer. ──
const ROUTER = '0xe92244e3368561faf21648146511DeDE3a475EB5';
const NFT_MARKET = '0x9625bEc5e2eD53B48e4CbcbBbe9287C00db31178';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia, 6 decimals

// ── The listing — set these for your own ERC-721 + merchant ──
const MERCHANT_ID = BigInt(process.env.MERCHANT_ID ?? '1');
const COLLECTION = process.env.COLLECTION ?? '0x0000000000000000000000000000000000000000'; // your ERC-721
const TOKEN_ID = BigInt(process.env.TOKEN_ID ?? '1');
const PRICE_USD = '50.00';
const priceUsd8 = parseUnits(PRICE_USD, 8); // USD-8: $50.00 -> 5_000_000_000
const LISTING_ID = BigInt(process.env.LISTING_ID ?? '0'); // buyer: the id `list` emitted

const erc721Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
];

const routerQuoteAbi = [
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
];

const nftAbi = [
  {
    type: 'function',
    name: 'list',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'collection', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'paymentToken', type: 'address' },
      { name: 'priceUsd8', type: 'uint256' },
    ],
    outputs: [{ name: 'listingId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'listingId', type: 'uint256' },
      { name: 'maxPriceUsd8', type: 'uint256' },
      { name: 'maxTokenAmount', type: 'uint256' },
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

async function sell(publicClient, walletClient, account) {
  // 1. Approve Access0x1Nft to escrow the NFT, then list it. `list` re-checks the NFT actually landed.
  const approveHash = await walletClient.writeContract({
    address: COLLECTION,
    abi: erc721Abi,
    functionName: 'approve',
    args: [NFT_MARKET, TOKEN_ID],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const { request, result: listingId } = await publicClient.simulateContract({
    account,
    address: NFT_MARKET,
    abi: nftAbi,
    functionName: 'list',
    args: [MERCHANT_ID, COLLECTION, TOKEN_ID, USDC, priceUsd8],
  });
  await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract(request) });
  console.log(`Listed token ${TOKEN_ID} at $${PRICE_USD}. listingId = ${listingId}`);
  console.log(`Buyer: run with ROLE=buyer LISTING_ID=${listingId}`);
}

async function buy(publicClient, walletClient, account) {
  // 1. Quote the gross in USDC at the live feed price — this is the buyer's token-outlay cap.
  const gross = await publicClient.readContract({
    address: ROUTER,
    abi: routerQuoteAbi,
    functionName: 'quote',
    args: [MERCHANT_ID, USDC, priceUsd8],
  });
  console.log(`Listing ${LISTING_ID}: $${PRICE_USD} = ${formatUnits(gross, 6)} USDC`);

  // 2. Approve the router to pull the gross (Access0x1Nft relays it through router.payToken).
  const approveHash = await walletClient.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [ROUTER, gross],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // 3. Buy — atomic: pull payment, fee-split through the router, NFT transfers to the buyer, same tx.
  //    maxPriceUsd8 must equal the listing price (consent to the exact USD). maxTokenAmount caps the
  //    token outlay against feed drift between quote and inclusion (pass `gross` for an exact cap).
  const { request } = await publicClient.simulateContract({
    account,
    address: NFT_MARKET,
    abi: nftAbi,
    functionName: 'buy',
    args: [LISTING_ID, priceUsd8, gross],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract(request),
  });
  console.log(`Bought. NFT delivered, payment settled — one tx. tx ${receipt.transactionHash}`);
}

async function main() {
  const key = process.env.PRIVATE_KEY;
  if (!key) throw new Error('Set PRIVATE_KEY to a funded testnet dev wallet (never a real key).');
  if (COLLECTION === '0x0000000000000000000000000000000000000000') {
    throw new Error('Set COLLECTION to your ERC-721 contract address.');
  }

  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });

  const role = process.env.ROLE ?? 'seller';
  if (role === 'buyer') {
    await buy(publicClient, walletClient, account);
  } else {
    await sell(publicClient, walletClient, account);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
