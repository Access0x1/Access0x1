# Deploying to Testnets

Operator guide for deploying `DeployAll` to a live testnet with a keystore. No
private keys are ever passed on the command line — all signing goes through
`cast wallet` keystores (law: signing is keystore-only).

> **Scope.** This is a testnet build. No mainnet deployments exist. Every address
> listed here must be confirmed from your chain's official docs
> before being set in `.env` — an unconfirmed address left blank is
> **skipped** by the script, never wired (address(0) is safe here).

---

## Contents

0. [Fastest path — deploy to every funded chain](#0-fastest-path--deploy-to-every-funded-chain-at-once)
1. [Prerequisites](#1-prerequisites)
2. [Import your keystore (once)](#2-import-your-keystore-once)
3. [Keyless local deploy (Anvil)](#3-keyless-local-deploy-anvil)
4. [Base Sepolia](#4-base-sepolia)
5. [Arc Testnet](#5-arc-testnet)
6. [Optional: deploy ChainRegistry separately](#6-optional-deploy-chainregistry-separately)
7. [After any deploy: record from the broadcast log](#7-after-any-deploy-record-from-the-broadcast-log)
8. [Gas notes](#8-gas-notes)
9. [Troubleshooting](#9-troubleshooting)

---

## 0. Fastest path — deploy to every funded chain at once

After Prerequisites (§1) + keystore import (§2), the whole fleet goes out in **one command**. The
per-chain sections below (§4 Base, §5 Arc, …) remain the detailed single-chain reference + troubleshooting.

1. **Verified addresses** — [`CHAIN-ADDRESSES.md`](CHAIN-ADDRESSES.md) lists, per testnet, the official
   Circle USDC + Chainlink feeds (each re-checked on-chain) and a **paste-ready `.env` block**.
2. **`.env`** — per chain set `<CHAIN>_RPC_URL` (prefer your **Alchemy/Tenderly** URL — public RPCs
   rate-limit across 20+ chains; the URL embeds a key, so `.env` only, never commit),
   `<CHAIN>_PLATFORM_TREASURY` (your wallet), the verified USDC/feed addresses, and the `*SCAN_API_KEY`
   for verification.
3. **Fund** the deployer on each chain you want (faucets are listed per chain in `CHAIN-ADDRESSES.md`).

```sh
make deploy-all-testnets
# Balance-prechecks every configured testnet, deploys the full stack to the FUNDED ones (keystore
# password per chain), skips unfunded with their faucet, continues past failures, prints a summary.
# Arc + Base Sepolia are EXCLUDED — already live; re-deploying would mint new addresses + break the app.
```

Chains with real USDC but **no Chainlink USDC/USD feed** (Linea / Unichain / World Chain / Celo /
Optimism Sepolia) deploy with USDC allowlisted-but-unpriced. To price it, deploy a `$1` stand-in feed
and set `<CHAIN>_USDC_USD_FEED` to the printed address before deploying that chain:

```sh
make deploy-usd-mock-feed RPC=$LINEA_SEPOLIA_RPC_URL
```

After deploying, record the addresses from the broadcast log (§7).

---

## 1. Prerequisites

| Tool | Version | Install |
| --- | --- | --- |
| Foundry | latest stable | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Node.js | 18 + | https://nodejs.org |
| Git | any | https://git-scm.com |

Clone and install dependencies (in that order — `@chainlink/contracts` resolves
through `node_modules`):

```sh
git clone https://github.com/Access0x1/Access0x1.git
cd Access0x1
make install    # git submodules + npm install + web + SDK
make build      # forge build — must exit 0 before any deploy
```

`make build` must exit 0. If it does not, do not proceed.

---

## 2. Import your keystore (once)

The deploy scripts read `--account deployer`. Import your burner key once and
never pass it on the command line again:

```sh
cast wallet import deployer --interactive
# paste the private key at the prompt — it is never echoed or stored in shell history
```

Confirm the address:

```sh
cast wallet address --account deployer
```

Set that address as `DEPLOYER` in your `.env` (copy `.env.example` first):

```sh
cp .env.example .env
# edit .env: set DEPLOYER=0x<your address>
```

`DEPLOYER` is your PUBLIC signing address. It is never a secret.

---

## 3. Keyless local deploy (Anvil)

A local Anvil node ships unlocked accounts, so no keystore is needed. This is
the fastest way to prove the scripts work end-to-end before spending testnet
funds.

**Terminal 1** — start the node:

```sh
make anvil
# or: anvil
```

**Terminal 2** — deploy the full surface:

```sh
make deploy-local
```

What this does: `DeployAll` detects `chainId 31337` (Anvil) via `HelperConfig`
and deploys fresh mock price feeds (native = $2 000, USDC = $1) plus a mock
USDC token. No real feeds, no real USDC, no real keys. Every contract in the
first-party surface is deployed and wired in the same broadcast.

Verify money moves:

```sh
make drive-local
# Runs the coffee-shop flow: registerMerchant → quote → payToken → net+fee==gross
```

Expected output: `net + fee == gross` logged by the Interactions script.

---

## 4. Base Sepolia

Base Sepolia uses standard 6-decimal Circle USDC and Chainlink Data Feeds.
Circle USDC on Base Sepolia is at `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
(verified from Circle docs as of ETHGlobal NY 2026 — confirm before use).

### 4a. Fill .env for Base Sepolia

```sh
# Required
BASE_SEPOLIA_PLATFORM_TREASURY=0x<your burner treasury wallet>
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Chainlink feeds (confirm at docs.chain.link/data-feeds/price-feeds/addresses?network=base&page=1)
BASE_SEPOLIA_NATIVE_USD_FEED=<ETH/USD feed address on Base Sepolia>
BASE_SEPOLIA_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
BASE_SEPOLIA_USDC_USD_FEED=<USDC/USD feed address on Base Sepolia>

# Verifier (from basescan.org)
BASESCAN_API_KEY=<your Basescan API key>

# Optional — omit to skip PaymentLanes
DEPLOY_PAYMENT_LANES=true
```

Leave any unconfirmed feed blank — the deploy script skips that `setPriceFeed`
call rather than wiring a placeholder.

### 4b. Deploy

```sh
make deploy-base-sepolia
```

Explicit equivalent (what Make runs):

```sh
forge script script/DeployAll.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --account deployer --sender $DEPLOYER \
  --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY \
  -vvvv
```

### 4c. Gas on Base Sepolia

Gas is paid in ETH. The router spine costs roughly 1.74 M gas to deploy;
`payToken` costs 105 k gas at the median (213 k with PaymentLanes enabled).
On Base Sepolia, ETH has no monetary value — use a faucet.

On chains where the native gas token is ETH (not USDC), gas can optionally be
sponsored through a generic [ERC-7677](https://eips.ethereum.org/EIPS/eip-7677)
paymaster seam — the buyer pays in USDC and a configured paymaster provider
covers the gas, so:

> **gas sponsored — buyer pays $0 in network fees (when a paymaster is configured)**

This seam is provider-agnostic and env-gated (`web/lib/paymaster`): it is OFF
unless a paymaster endpoint is set, and the app brands no specific provider.
There is no Paymaster code in the contracts — the buyer-side gas abstraction is
a frontend / SDK concern. The contracts are gas-model agnostic.

---

## 5. Arc Testnet

Arc is Circle's purpose-built settlement chain (chain ID 5042002). Its
distinguishing property is that **Circle USDC is the native gas token** — a
buyer paying in USDC also pays gas in USDC. There is no separate gas coin to
top up and no Paymaster to run.

> **no separate gas token on Arc — USDC is native, no gas coin to top up**

The system contract address for the Arc native USDC asset is at
`0x3600000000000000000000000000000000000000` (the Arc "zero-address" reserved
slot — confirmed from Arc testnet docs; confirm at the Arc/Circle booth before
use). The ERC-20 USDC address (if Circle deploys one as an ERC-20 alongside the
native asset) is a separate booth confirmation.

### 5a. Fill .env for Arc

```sh
# Required
ARC_PLATFORM_TREASURY=0x<your burner treasury wallet>
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network   # confirm at Arc/Circle booth
ARC_SCAN_VERIFIER_URL=<Blockscout verifier URL>        # confirm at Arc booth

# Feeds + USDC (confirm at Chainlink/Arc booth)
ARC_NATIVE_USD_FEED=<native/USD Chainlink feed on Arc>
ARC_USDC_ADDRESS=<Arc ERC-20 USDC — confirm at Circle booth>
ARC_USDC_USD_FEED=<USDC/USD Chainlink feed on Arc>

# Optional
DEPLOY_PAYMENT_LANES=true
ARC_CRE_FORWARDER=<Chainlink CRE KeystoneForwarder on Arc — confirm at CRE booth>
```

### 5b. Deploy

```sh
make deploy-arc
```

Explicit equivalent:

```sh
forge script script/DeployAll.s.sol \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --account deployer --sender $DEPLOYER \
  --broadcast --verify \
  --verifier blockscout --verifier-url $ARC_SCAN_VERIFIER_URL \
  -vvvv
```

Arc uses Blockscout for verification (not Etherscan). The `--verifier-url`
value must end in `/api` — confirm the exact URL at the Arc booth.

### 5c. Gas on Arc

On Arc, USDC is the native gas token. A `payToken(USDC, ...)` call therefore
pays gas in the same token the buyer is spending:

> **no separate gas token on Arc — USDC is native**

No Paymaster is required, no gas coin faucet is needed, and no Paymaster
contract lives in this repo. Arc's Circle Nanopayments layer handles the buyer's
gas at the chain level. The deployed contracts do not change for this to work —
they are gas-model agnostic.

### 5d. Chainlink CRE consumer (optional)

`DeployAll` deploys the off-money-path `Access0x1Receiver` CRE audit consumer
only when `ARC_CRE_FORWARDER` is set. If the CRE booth confirms a
`KeystoneForwarder` address:

```sh
export ARC_CRE_FORWARDER=<forwarder address from Chainlink CRE booth>
make deploy-arc
```

The consumer sits off the money path by construction — a revert in it can never
touch a payment. If the forwarder address is not yet confirmed, leave it blank:
the router, SessionGrant, and commerce quartet deploy unchanged.

The CRE workflow itself (the offchain automation) lives in `cre/`:

```sh
make cre-build    # build the CRE workflow artifact (requires the CRE CLI)
make cre-sim      # simulate the workflow locally
```

---

## 6. Optional: deploy ChainRegistry separately

`ChainRegistry` is the SDK cross-chain reference sidecar. It is deployed once
per chain (not once per `DeployAll` run) by a separate script:

```sh
# On Arc (or any chain — point --rpc-url at the target):
forge script script/DeployChainRegistry.s.sol \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --account deployer --sender $DEPLOYER \
  --broadcast -vvvv
```

Env vars consumed (all optional — zero if unset):

| Var | What it seeds |
| --- | --- |
| `ARC_USDC` | Arc native USDC address in the registry |
| `BASE_SEPOLIA_USDC` | Base Sepolia USDC |
| `BASE_SEPOLIA_CCIP_SELECTOR` | Base Sepolia CCIP lane selector |
| `ZKSYNC_SEPOLIA_USDC` | zkSync Sepolia USDC |
| `REGISTRY_OWNER` | Final Ownable2Step owner (broadcaster if unset) |

After deploy, copy the logged `ChainRegistry deployed:` address into
`ARC_CHAIN_REGISTRY` (or the chain-prefixed equivalent) in `.env` so subsequent
`DeployAll` runs carry it in the console log.

---

## 7. After any deploy: record from the broadcast log

Every deployed address is logged to `broadcast/<chainId>/DeployAll.s.sol/run-latest.json`.
Record the addresses in the README Deployments table:

```sh
# Extract Access0x1Router address from the broadcast log
jq '.transactions[] | select(.contractName == "Access0x1Router") | .contractAddress' \
  broadcast/84532/DeployAll.s.sol/run-latest.json
```

Replace `84532` with the chain ID of the chain you deployed to (Arc = 5042002,
zkSync Sepolia = 300, etc.).

Fill in the README table from the log output — never hand-enter an address that
is not in a broadcast receipt.

---

## 8. Gas notes

Full per-function gas figures are in [`docs/GAS.md`](GAS.md). Summary for the
settlement hot paths:

| Function | Median gas | What it does |
| --- | ---: | --- |
| `payNative` | 95 526 | In-tx Chainlink quote → split fee → push net, refund excess |
| `payToken` | 105 177 | Pull ERC-20 → verify → split → SafeERC20 push |
| `payToken` (+ PaymentLanes) | ~213 060 max | Same + mint ERC-6909 lane receipt |
| `registerMerchant` | 122 209 | One-time onboarding write |

Deployment cost for the full surface: `Access0x1Router` alone ~1.74 M gas;
full `DeployAll` (all 9 contracts + configure) is additive.

### Chain-specific gas notes

**Arc Testnet:**
> No separate gas token on Arc — USDC is native. The buyer pays settlement and
> gas in the same USDC balance, with no Paymaster to run.

**Base Sepolia / Base Mainnet:**
> Gas is paid in ETH on Base. An optional, generic ERC-7677 paymaster seam can
> sponsor gas where a provider is configured — buyers pay in USDC, gas sponsored,
> $0 in network fees. The seam is provider-agnostic and env-gated; no paymaster
> contract code lives in this repo, it is a frontend SDK integration.

**zkSync Sepolia:**
> Requires `foundry-zksync` (`foundryup-zksync`) and `--zksync` flag. See
> [`docs/ZKSYNC-TESTING.md`](ZKSYNC-TESTING.md) for full notes. A plain EVM
> build is NOT the zkEVM bytecode.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `vm.envAddress("…_PLATFORM_TREASURY")` reverts | Treasury env var is unset | Set `<CHAIN>_PLATFORM_TREASURY=0x…` in `.env` |
| `Access0x1__InvalidPrice` at runtime | Feed address not set or stale | Confirm the Chainlink feed address and set `<CHAIN>_NATIVE_USD_FEED` / `<CHAIN>_USDC_USD_FEED` |
| `setTokenAllowed` / `setPriceFeed` reverts during deploy | `ROUTER_OWNER` differs from broadcaster | Expected — admin runs `setTokenAllowed`/`setPriceFeed` from its own key |
| Verification fails on Arc | Wrong `--verifier-url` format | URL must end in `/api` (Blockscout) |
| `forge build` errors mentioning `@chainlink` | `npm install` not run | Run `make install` or `npm install` first |
| zkSync deploy fails with opcode error | Wrong forge binary | Use `foundryup-zksync` (the ZK Stack fork) |
