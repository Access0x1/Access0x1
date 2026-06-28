# NFT marketplace — list at a USD price, buy atomically

A seller lists an **ERC-721 at $50.00**; a buyer pays an allowlisted token and the
**NFT transfers in the same transaction as the payment**. [`Access0x1Nft`](../../src/Access0x1Nft.sol)
is a **zero-custody** marketplace primitive: the router (`payToken`) does all pricing
and the fee-split, and `Access0x1Nft` never holds a payment token — it only escrows
the listed NFT between `list` and `buy`/`cancelListing`. The NFT leg uses
`safeTransferFrom`, so if delivery would fail the whole purchase reverts and the
money rolls back with it.

Run it: [`list-and-buy.mjs`](./list-and-buy.mjs) (Node + [viem](https://viem.sh)),
once as `ROLE=seller` and once as `ROLE=buyer`.

## Value flow

### Before — seller holds the NFT; buyer holds the USDC

```
seller wallet        Access0x1Nft         buyer wallet        merchant payout
 [ NFT #1 ]          (no listing)          [ USDC ]            balance n
```

### After — list escrows the NFT; buy swaps NFT ⇄ payment atomically

```
SELLER
seller ──approve(Access0x1Nft, tokenId)──▶ ERC-721
seller ──list(merchantId, collection, tokenId, USDC, 5_000_000_000)──▶ Access0x1Nft
                                                          └─ escrows NFT, returns listingId

BUYER  (one tx)
buyer ──approve(router, gross)──▶ USDC
buyer ──buy(listingId, priceUsd8, maxTokenAmount)──▶ Access0x1Nft
            │  quote($50.00) = gross USDC (Chainlink, in-tx)
            ├─▶ router.payToken ──┬─▶ merchant payout (+ net)
            │                     └─▶ treasury        (+ fee)
            └─▶ ERC-721 safeTransferFrom ──▶ buyer        (NFT delivered)

   atomic:  NFT ⇄ payment in one tx     Access0x1Nft holds no payment token (zero custody)
```

`$50.00` is `5_000_000_000` in the router's **USD-8** fixed point.

### Two buyer-protection bounds on `buy`

- **`maxPriceUsd8`** must equal the listing price — the buyer's explicit consent to
  the exact USD, defeating a seller price-bump or a swapped listing between quote and
  submit.
- **`maxTokenAmount`** is a hard cap on the token outlay. The fixed USD price
  re-prices against the live Chainlink feed in-tx, so the token units can drift
  between consent and inclusion; this bound reverts before any token moves if the
  quote exceeds it. Pass the quoted `gross` for an exact cap, or `2**256 - 1` to opt
  out of the slippage bound.

## Prerequisites

1. A **registered merchant** (its owner is the listing's authority — only the
   merchant owner can `list`).
2. An **ERC-721 you own** on Base Sepolia (set `COLLECTION` + `TOKEN_ID`), plus USDC
   allowlisted on the router for that merchant.
3. A **funded testnet dev wallet** (Base Sepolia ETH for gas, testnet USDC for the
   buyer). Throwaway key only — **never** a key with real value.

## Run

```sh
npm i viem
export RPC_URL=https://sepolia.base.org
export PRIVATE_KEY=0x<funded-dev-key>
export MERCHANT_ID=<your registered id>      # defaults to 1
export COLLECTION=0x<your-erc721>
export TOKEN_ID=<your token id>

# seller side — escrow + list, prints the listingId
ROLE=seller node list-and-buy.mjs

# buyer side — quote, approve, buy atomically (use the printed listingId)
ROLE=buyer LISTING_ID=<id> node list-and-buy.mjs
```

## Addresses

`Access0x1Nft` = `0x9625bEc5e2eD53B48e4CbcbBbe9287C00db31178`, `Access0x1Router` =
`0xe92244e3368561faf21648146511DeDE3a475EB5`, USDC =
`0x036CbD53842c5426634e7929541eC2318f3dCF7e` on **Base Sepolia** (`84532`), all from
the **CREATE3 mirror** (identical on every mirrored chain). Source of truth: the
README [Deployments](../../README.md#deployments) table — re-confirm on the explorer
before real value (LAW #4).
