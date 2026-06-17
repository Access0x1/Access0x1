# Deploy your own Access0x1 contracts

These are **your** contracts. Deploying them gives you a non-custodial `Access0x1Router` with **zero
dependency on us** — buyers pay you directly (buyer → router → your payout + your treasury in one
on-chain tx). The router never holds keys or funds.

> **LAW #4 — truth in copy / guardrail #5:** never wire an invented address. Every feed / USDC /
> treasury address comes from your chain's official docs. A value that resolves to
> `address(0)` (not yet confirmed) is **skipped** by the deploy script, never wired as a guess.

## 0. Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`, `cast`, `anvil`)
- Node.js >= 18 (for the `@chainlink/contracts` npm dependency)

## 1. Install dependencies

```bash
npm install                         # @chainlink/contracts (1.5.0) into node_modules
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
```

`foundry.toml` / `remappings.txt` already map:

| remapping | resolves to |
|---|---|
| `@openzeppelin/contracts/` | `lib/openzeppelin-contracts/contracts/` (git, via `forge install`) |
| `@chainlink/contracts/` | `node_modules/@chainlink/contracts/` (npm) |
| `forge-std/` | `lib/forge-std/src/` (git, via `forge install`) |

## 2. Build + test

```bash
forge build
forge test
```

## 3. Deploy locally first (no RPC, no env — fresh mocks)

`HelperConfig` deploys mock Chainlink feeds + a mock USDC on a local Anvil chain (id 31337), so the
whole flow runs offline end-to-end:

```bash
anvil                                          # in one terminal
forge script script/DeployAll.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast
```

The logged `Access0x1Router deployed :` address is what your app's `NEXT_PUBLIC_ROUTER_ADDRESS_*`
points at locally.

## 4. Deploy to a live testnet (keystore-only signing)

Set the per-chain env the script reads (see `script/HelperConfig.s.sol`). Each named chain reads its
**own prefixed** vars so a second chain never reuses the first's addresses:

```bash
# Required: where the platform fee leg lands.
export ARC_PLATFORM_TREASURY=0xYourTreasury
# Optional (skipped until confirmed): Chainlink feeds + Circle USDC.
export ARC_NATIVE_USD_FEED=        # confirm at Chainlink booth / docs.chain.link/data-feeds
export ARC_USDC_ADDRESS=           # confirm at Circle booth
export ARC_USDC_USD_FEED=          # confirm at Chainlink booth
export ARC_TESTNET_RPC_URL=        # confirm at Arc booth
```

**Never pass `--private-key`.** Import your deployer key into a keystore once
(`cast wallet import deployer --interactive`), then:

```bash
# Arc Testnet
forge script script/DeployAll.s.sol \
  --rpc-url "$ARC_TESTNET_RPC_URL" \
  --account deployer --sender "$DEPLOYER" \
  --broadcast -vvvv

# Base Sepolia (set BASE_SEPOLIA_* vars instead; Basescan verify)
forge script script/DeployAll.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account deployer --sender "$DEPLOYER" \
  --broadcast --verify --etherscan-api-key "$BASESCAN_API_KEY" -vvvv

# zkSync Sepolia (only if cancun bytecode is rejected — booth confirm)
forge script script/DeployAll.s.sol --profile zksync \
  --rpc-url "$ZKSYNC_SEPOLIA_RPC_URL" \
  --account deployer --sender "$DEPLOYER" --broadcast -vvvv
```

Set `DEPLOY_PAYMENT_LANES=true` to also deploy the `PaymentLanes` ERC-6909 receipt ledger and wire
it into the router in the same broadcast.

## 5. Register a merchant + wire the app

1. Read the deployed router address from `broadcast/<chainId>/run-latest.json` (or the console log).
2. Call `registerMerchant(payout, feeRecipient, feeBps, nameHash)` on the router — the
   `MerchantRegistered` event returns your `merchantId`. (Zero custody: this only writes the
   registry; no funds move.)
3. Put the router address in your app's `.env.local`:
   `NEXT_PUBLIC_ROUTER_ADDRESS_<chainId>=0x...`, and set `MERCHANT_ID` in `app/app/page.tsx`.

That's it — your checkout now settles to **your** router. No dependency on Access0x1 infra.
