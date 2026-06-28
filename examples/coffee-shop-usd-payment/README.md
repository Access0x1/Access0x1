# Coffee shop — one USD-priced payment

A buyer pays **$4.50 for one coffee** in a single on-chain transaction. The price
is quoted in USD and converted to a token amount by the router's Chainlink feed
**inside the same tx** — no off-chain price oracle to trust. The buyer pays, the
merchant gets the net, the treasury gets the capped fee, all in the same block,
and the router holds nothing.

Run it: [`pay.mjs`](./pay.mjs) (Node + [viem](https://viem.sh)).

## Value flow

### Before — the buyer holds the USDC, the merchant has nothing

```
buyer wallet        Access0x1Router        merchant payout       treasury
 [ USDC ]            balance ~0              balance n             balance m
```

### After — one tx, split exactly, router still holds nothing

```
buyer ──approve(router, gross)──▶ USDC
buyer ──payToken(merchantId, USDC, 450_000_000, orderId)──▶ Access0x1Router
                                                              │
   quote($4.50) = gross USDC  (Chainlink feed, read in-tx)    │
                                                              ├─▶ merchant payout   (+ net)
                                                              └─▶ treasury          (+ fee)

   invariant:  net + fee == gross          router balance: still ~0 (zero custody)
```

`$4.50` is `450_000_000` in the router's **USD-8** fixed point (8 decimals). The
`gross` is however much USDC `quote` returns for that USD at the live feed price.

## Prerequisites

1. A **registered merchant**. Anyone can register permissionlessly — call
   `registerMerchant(payout, feeRecipient, feeBps, nameHash)` on the router; the
   call returns your `merchantId`. See [RECIPES](../../docs/RECIPES.md) and the
   Router functions table in the [README](../../README.md#router-functions).
2. A **funded testnet dev wallet**. Get Base Sepolia ETH for gas from a faucet and
   testnet USDC from [Circle's faucet](https://faucet.circle.com). Use a throwaway
   key — **never** a key that holds real value.

## Run

```sh
npm i viem                                   # or run from a repo checkout
export RPC_URL=https://sepolia.base.org      # any Base Sepolia RPC
export PRIVATE_KEY=0x<funded-dev-key>        # throwaway testnet wallet
export MERCHANT_ID=<your registered id>      # defaults to 1 if unset
node pay.mjs
```

Expected output:

```
$4.50 = 4.5 USDC (gross the router will pull)
Paid. tx 0x… (block …)
net + fee == gross, settled in one block — the router kept nothing.
```

## Addresses

`Access0x1Router` = `0xe92244e3368561faf21648146511DeDE3a475EB5` and Circle USDC
= `0x036CbD53842c5426634e7929541eC2318f3dCF7e` on **Base Sepolia** (chain `84532`).
The router address is the **CREATE3 mirror** — identical on every mirrored chain, so
the same script runs elsewhere by only changing `RPC_URL` and the USDC token. Always
re-confirm on the explorer (LAW #4); the source of truth is the README
[Deployments](../../README.md#deployments) table.
