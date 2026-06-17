# Testnet chain addresses — verified, for the multi-chain deploy

Every address below was taken from an **official first-party source** (Circle's USDC contract
list, Chainlink's reference data directory / `docs.chain.link`, or the chain's own docs) **and**
re-verified **on-chain** on 2026-06-17 — each USDC returns `symbol()="USDC"` / `decimals()=6`,
each feed returns the right `description()` (e.g. `"ETH / USD"`) at `decimals()=8`. Nothing here is
guessed (law #4). Where no official source publishes a USDC or a Chainlink feed for a testnet, the
row is left blank on purpose — that chain deploys a **bare** router + stack (no USD pricing) until a
feed exists; it is never wired to a placeholder.

`make deploy-all-testnets` deploys to every **funded** chain; `script/deploy-all-testnets.sh`
skips any chain with 0 gas and prints its faucet. Arc + Base Sepolia are excluded (already live).

## Live (deployed + verified)

| Chain | id | Router | USDC | native/USD | USDC/USD |
|---|---|---|---|---|---|
| Arc Testnet | 5042002 | `0xa598…9aad` | `0x3600…0000` (native) | `0x60eb…8008` ($1 mock) | `0x60eb…8008` ($1 mock) |
| Base Sepolia | 84532 | `0xec89…E8E57` | `0x036CbD…dCF7e` | `0x4aDC67…7cb1` (ETH/USD) | `0xd30e21…5165` |

## Ready to deploy — fully priced (USDC + USDC/USD feed)

| Chain | id | USDC | native/USD feed | USDC/USD feed |
|---|---|---|---|---|
| zkSync Sepolia | 300 | `0xAe045DE5638162fa134807Cb558E15A3F5A7F853` | `0xfEefF7c3fB57d18C5C6Cdd71e45D2D0b4F9377bF` (ETH/USD) | `0x1844478CA634f3a762a2E71E3386837Bd50C947F` |
| Polygon Amoy | 80002 | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | — (no POL/USD on Chainlink Amoy) | `0x1b8739bB4CdF0089d07097A9Ae5Bd274b29C6F16` |
| Avalanche Fuji | 43113 | `0x5425890298aed601595a70AB815c96711a31Bc65` | `0x11FeeA5D7Ec56EE717D8a229e8aac5d8AdB238Aa` (AVAX/USD) | `0x64d45610cF1F603D892CcC8f0F269516C45084eB` |

## Ready — partial pricing

| Chain | id | USDC | feeds | note |
|---|---|---|---|---|
| BNB Smart Chain testnet | 97 | — (no Circle USDC) | BNB/USD `0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526` · USDC/USD `0x90c069C4538adAc136E051052E14c1cD799C41B7` | native BNB priced; no canonical USDC token to allowlist |
| Linea Sepolia | 59141 | `0xFEce4462D57bD51A6A552365A011b95f0E16d9B7` | — (Chainlink: CCIP only, no feeds) | USDC allowlisted but unpriced until a feed is set |
| Unichain Sepolia | 1301 | `0x31d0220469e10c4E71834a79b1f276d740d3768F` | — | USDC allowlisted but unpriced |
| World Chain Sepolia | 4801 | `0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88` | — (Data Streams on mainnet only) | USDC allowlisted but unpriced |
| Celo Sepolia | 11142220 | `0x01C5C0122039549AD1493B8220cABEdD739BC44E` | — | USDC allowlisted but unpriced |

> For an "unpriced USDC" chain, add pricing without redeploying: deploy a `$1.00` USDC/USD mock
> (the `script/DeployArcUsdFeed.s.sol` pattern) and call the owner-only `setPriceFeed(usdc, mock)`,
> exactly as Arc does (USDC ≈ $1).

## Bare deploy — no official USDC or Chainlink feed (router + commerce stack only)

Scroll Sepolia (534351 — feeds are a JS SPA Chainlink page that could not be confirmed first-party;
owner can confirm at docs.chain.link), Mantle Sepolia (5003), Blast Sepolia (168587773),
Zora Sepolia (999999999), Filecoin Calibration (314159), Gnosis Chiado (10200),
ApeChain Curtis (33111), Zircuit Garfield (48898 — uses Redstone/API3, not Chainlink),
Citrea (5115), Flow EVM testnet (545 — uses Pyth). These deploy the full first-party surface
(proving multi-chain reach); USD-priced payments turn on when a feed is wired.

## Paste-ready `.env` (verified public addresses — not secrets)

```sh
# ── verified on-chain 2026-06-17 (Circle + Chainlink official sources) ──
ZKSYNC_SEPOLIA_USDC_ADDRESS=0xAe045DE5638162fa134807Cb558E15A3F5A7F853
ZKSYNC_SEPOLIA_NATIVE_USD_FEED=0xfEefF7c3fB57d18C5C6Cdd71e45D2D0b4F9377bF
ZKSYNC_SEPOLIA_USDC_USD_FEED=0x1844478CA634f3a762a2E71E3386837Bd50C947F
POLYGON_AMOY_USDC_ADDRESS=0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582
POLYGON_AMOY_USDC_USD_FEED=0x1b8739bB4CdF0089d07097A9Ae5Bd274b29C6F16
AVALANCHE_FUJI_USDC_ADDRESS=0x5425890298aed601595a70AB815c96711a31Bc65
AVALANCHE_FUJI_NATIVE_USD_FEED=0x11FeeA5D7Ec56EE717D8a229e8aac5d8AdB238Aa
AVALANCHE_FUJI_USDC_USD_FEED=0x64d45610cF1F603D892CcC8f0F269516C45084eB
BNB_TESTNET_NATIVE_USD_FEED=0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526
BNB_TESTNET_USDC_USD_FEED=0x90c069C4538adAc136E051052E14c1cD799C41B7
LINEA_SEPOLIA_USDC_ADDRESS=0xFEce4462D57bD51A6A552365A011b95f0E16d9B7
UNICHAIN_SEPOLIA_USDC_ADDRESS=0x31d0220469e10c4E71834a79b1f276d740d3768F
WORLDCHAIN_SEPOLIA_USDC_ADDRESS=0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88
CELO_SEPOLIA_USDC_ADDRESS=0x01C5C0122039549AD1493B8220cABEdD739BC44E
# (still required per chain: <CHAIN>_PLATFORM_TREASURY = your wallet, and the *SCAN_API_KEY for verify)
```

All 20 testnet RPCs were confirmed live with a matching `eth_chainId` on 2026-06-17.
