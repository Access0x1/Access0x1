# Arc Testnet Deploy Runbook

Arc testnet (chainId 5042002) is one of the supported settlement chains. USDC is the **native gas token** on Arc,
so there is no published Chainlink USDC/USD oracle — the peg is enforced by the chain design. This
runbook shows how to deploy a $1.00 price-feed stand-in before the main `make deploy-arc` broadcast.

> **Arc is one of the eight chains the CREATE3 mirror is live on.** A `make deploy-arc` via `DeployAll`
> lands the whole first-party surface at the mirror address set (the `Access0x1Router` proxy is
> `0xe92244e3368561faf21648146511DeDE3a475EB5` here, identical on every mirrored chain — see
> [`../script/mirror-manifest.json`](../script/mirror-manifest.json) and the README Deployments table).
> The USD-feed stand-in below is the one Arc-specific prerequisite, because Arc has no published
> Chainlink USDC/USD oracle.

---

## Step 1 — Fund the deployer wallet

Arc gas is paid in USDC (native). Get testnet USDC at:

```
https://faucet.circle.com
```

Select **Arc Testnet** and request funds to the deployer address
(`cast wallet address --account deployer`). A small amount (e.g. 1–5 USDC) covers multiple deploys.

---

## Step 2 — Deploy the USDC/USD feed stand-in

Run `script/DeployArcUsdFeed.s.sol`. It deploys a `MockV3Aggregator` initialized to $1.00 (8 decimals,
answer = `1e8`) and logs its address.

```sh
forge script script/DeployArcUsdFeed.s.sol \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --account deployer \
  --sender $DEPLOYER \
  --broadcast \
  --verify --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api? \
  --gas-price 20000000000 \
  -vvvv
```

`--gas-price 20000000000` sets `maxFeePerGas` to 20 gwei, which Arc testnet requires
(the mempool rejects transactions priced below that floor).

The script prints:

```
==> Arc USDC/USD feed deployed at: 0x<feed>
    Set in .env:
      ARC_USDC_USD_FEED=0x<feed>
```

Copy the address.

---

## Step 3 — Set `ARC_USDC_USD_FEED` in `.env`

```sh
# .env
ARC_USDC_USD_FEED=0x<address from Step 2>
```

`HelperConfig._arcTestnetConfig()` reads this env var and passes it to `DeployAll` as
`NetworkConfig.usdcUsdFeed`. When non-zero, `DeployAll` calls `setPriceFeed(usdc, feed)` to wire the
router so it can price USDC-settled payments. If the var is blank `DeployAll` skips that configure
call and logs a warning — the rest of the deploy still succeeds.

---

## Step 4 — Deploy the full protocol stack

```sh
make deploy-arc
```

Which expands to:

```sh
forge script script/DeployAll.s.sol \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --account deployer --sender $DEPLOYER \
  --broadcast \
  --verify --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api? \
  -vvvv
```

The `--verifier-url` above points to the Arc testnet Blockscout API. Confirm the exact URL at the
Arc/Circle booth — it may have a trailing `?` to suppress the standard Etherscan `&apikey=` suffix
that Blockscout does not use.

---

## Arc-specific notes

| Item | Detail |
|------|--------|
| Gas token | USDC (native, 18 decimals on Arc) |
| ERC-20 USDC | Separate token (6 decimals) — confirm address at Circle booth; set `ARC_USDC_ADDRESS` |
| Native/USD feed | No Chainlink native/USD feed confirmed on Arc testnet; leave `ARC_NATIVE_USD_FEED` blank |
| USDC/USD feed | No published Chainlink feed; use `script/DeployArcUsdFeed.s.sol` (this doc) |
| Verifier | Blockscout at `https://testnet.arcscan.app/api?` (confirm URL at booth) |
| Min gas price | 20 gwei (`--gas-price 20000000000`) required by Arc testnet mempool |
| RPC | `ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network` (confirm at booth) |

The feed deployed by `DeployArcUsdFeed` is a `MockV3Aggregator` — appropriate for testnet where the
$1.00 peg is a chain invariant, not a price-discovery signal. It is never deployed to any production
chain.
