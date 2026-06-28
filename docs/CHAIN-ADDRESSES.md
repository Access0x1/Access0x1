# Testnet chain addresses — verified, for the multi-chain deploy

Every address below was taken from an **official first-party source** (Circle's USDC contract
list, Chainlink's reference data directory / `docs.chain.link`, or the chain's own docs) **and**
re-verified **on-chain** on 2026-06-17 — each USDC returns `symbol()="USDC"` / `decimals()=6`,
each feed returns the right `description()` (e.g. `"ETH / USD"`) at `decimals()=8`. Nothing here is
guessed (law #4). Where no official source publishes a USDC or a Chainlink feed for a testnet, the
row is left blank on purpose — that chain deploys a **bare** router + stack (no USD pricing) until a
feed exists; it is never wired to a placeholder.

Deploy one chain at a time with `make deploy-<chain>` (e.g. `make deploy-base-sepolia`); fund the
deployer first — faucets are listed per chain below. Arc + Base Sepolia are already live — don't
re-deploy them (it mints new addresses).

> **RPC:** the public endpoints in `.env.example` rate-limit across 20+ chains. For the broadcast,
> set each `<CHAIN>_RPC_URL` to your **Alchemy** (`https://<net>.g.alchemy.com/v2/<KEY>`) or
> **Tenderly** (`https://<net>.gateway.tenderly.co/<KEY>`) URL — more reliable, and Tenderly adds
> simulation + a verifier. Those URLs embed an API key (secret) → `.env` only, never committed.

## Live (deployed + verified)

> **`Router` column — treat [`web/lib/deployments.ts`](../web/lib/deployments.ts) as authoritative.** The
> per-chain router addresses below predate the CREATE3 mirror cutover + an interim redeploy and may be
> stale; the broadcast-derived `web/lib/deployments.ts` is the source of truth. **Base Sepolia now runs
> the CREATE3 mirror** — `Access0x1Router` = `0xe92244e3368561faf21648146511DeDE3a475EB5`, the same on
> every mirrored chain (see [`MIRROR-CUTOVER.md`](MIRROR-CUTOVER.md)). The USDC + Chainlink-feed columns
> are first-party-verified and current.

| Chain | id | Router | USDC | native/USD | USDC/USD |
|---|---|---|---|---|---|
| Arc Testnet | 5042002 | `0xa598…9aad` | `0x3600…0000` (native) | `0x60eb…8008` ($1 mock) | `0x60eb…8008` ($1 mock) |
| Base Sepolia | 84532 | `0xe922…a475EB5` (mirror) | `0x036CbD…dCF7e` | `0x4aDC67…7cb1` (ETH/USD) | `0xd30e21…5165` |
| Ethereum Sepolia | 11155111 | `0x75aad7079f3e3b9f51b46529e5f235934af2e932` | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `0x694AA1769357215DE4FAC081bf1f309aDC325306` (ETH/USD) | `0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E` |
| Optimism Sepolia | 11155420 | `0xc7ed3886ec8995531531cb2659d6b4bc4519c231` | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | `0x61Ec26aA57019C486B10502285c5A3D4A4750AD7` (ETH/USD) | `0x6e44e50E3cc14DD16e01C590DC1d7020cb36eD4C` |
| Avalanche Fuji | 43113 | `0x60eb647d166b70662e0567551af7e575f13e8008` | `0x5425890298aed601595a70AB815c96711a31Bc65` | `0x5498BB86BC934c8D34FDA08E81D444153d0D06aD` (AVAX/USD) | `0x97FE42a7E96640D932bbc0e1580c73E705A8EB73` |

## Ready to deploy — fully priced (USDC + USDC/USD feed)

| Chain | id | USDC | native/USD feed | USDC/USD feed |
|---|---|---|---|---|
| Arbitrum Sepolia | 421614 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165` (ETH/USD) | `0x0153002d20B96532C639313c2d54c3dA09109309` |
| zkSync Sepolia | 300 | `0xAe045DE5638162fa134807Cb558E15A3F5A7F853` | `0xfEefF7c3fB57d18C5C6Cdd71e45D2D0b4F9377bF` (ETH/USD) | `0x1844478CA634f3a762a2E71E3386837Bd50C947F` |
| Polygon Amoy | 80002 | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | — (no POL/USD on Chainlink Amoy) | `0x1b8739bB4CdF0089d07097A9Ae5Bd274b29C6F16` |
| Scroll Sepolia | 534351 | — (no Circle USDC; bridged token TBD) | `0x59F1ec1f10bD7eD9B938431086bC1D9e233ECf41` (ETH/USD) | `0xFadA8b0737D4A3AE7118918B7E69E689034c0127` |

_Fuji was corrected to Chainlink's canonical pair, and Optimism + Scroll Sepolia were promoted here
after the 2026-06-17 Chainlink-RDD re-verification (both feeds confirmed live on-chain — see note below)._

## Ready — partial pricing

| Chain | id | USDC | feeds | note |
|---|---|---|---|---|
| BNB Smart Chain testnet | 97 | — (no Circle USDC) | BNB/USD `0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526` · USDC/USD `0x90c069C4538adAc136E051052E14c1cD799C41B7` | native BNB priced; no canonical USDC token to allowlist |
| Linea Sepolia | 59141 | `0xFEce4462D57bD51A6A552365A011b95f0E16d9B7` | — (Chainlink: CCIP only, no feeds) | USDC allowlisted but unpriced until a feed is set |
| Unichain Sepolia | 1301 | `0x31d0220469e10c4E71834a79b1f276d740d3768F` | — | USDC allowlisted but unpriced |
| World Chain Sepolia | 4801 | `0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88` | — (Data Streams on mainnet only) | USDC allowlisted but unpriced |
| Celo Sepolia | 11142220 | `0x01C5C0122039549AD1493B8220cABEdD739BC44E` | — | USDC allowlisted but unpriced |

> For an "unpriced USDC" chain (Linea/Unichain/World Chain/Celo Sepolia), turn on pricing:
> `make deploy-usd-mock-feed RPC=<that chain's RPC>` deploys a `$1.00` USDC/USD mock (the Arc pattern,
> generalized in `script/DeployUsdMockFeed.s.sol`); set the printed address as `<CHAIN>_USDC_USD_FEED`
> and deploy. Real USDC stays the token — only the missing *price feed* is stood in (USDC ≈ $1).

## Bare deploy — no official USDC or Chainlink feed (router + commerce stack only)

Mantle Sepolia (5003), Blast Sepolia (168587773),
Zora Sepolia (999999999), Filecoin Calibration (314159), Gnosis Chiado (10200),
ApeChain Curtis (33111), Zircuit Garfield (48898 — uses Redstone/API3, not Chainlink),
Citrea (5115), Flow EVM testnet (545 — uses Pyth). These deploy the full first-party surface
(proving multi-chain reach); USD-priced payments turn on when a feed is wired.

## Extra Chainlink-faucet testnets — bare, generic-fallback deploy (38)

Every other testnet on Chainlink's faucet list, validated live + chainId-matched (2026-06-17) — each
deployable as a bare router + stack (the generic `DeployAll` script, `--legacy`, broadcast
-only): WEMIX (1112), Metis Sepolia (59902), Polygon Cardona zkEVM (2442), Mode Sepolia (919), Cronos
zkEVM (240), Cronos (338), Soneium Minato (1946), Hedera (296), Corn (21000001), Astar Shibuya (81),
Sei atlantic-2 (1328), BOB Sepolia (808813), Bitlayer (200810), Plume (98867), Abstract (11124), Lisk
Sepolia (4202), Metal L2 (1740), Superseed (53302), opBNB (5611), Neo X T4 (12227332), Kaia Kairos
(1001), TAC (2391), Plasma (9746), Berachain Bepolia (80069), Jovay (2019775), AB (26888), Pharos
Atlantic (688689), Morph Hoodi (2910), Ethereum Hoodi (560048), MegaETH (6343), Monad (10143), DogeOS
(6281971), ADI (99999), Ronin Saigon (202601), Edge (33431), Robinhood (46630), Tempo Moderato (42431),
Creditcoin (102031). Each carries USDC/feeds on its own chain in a few cases (Hedera, Monad, Sei, Plume,
Pharos, Morph, Edge) — wire + on-chain-verify those before relying on pricing.

**Dropped (5)** — re-add with a working RPC: Shibarium Puppynet (157), Core (1115), Mind Network
(192940), XDC Apothem (51) — RPC dead at check time; X Layer (195) — its RPC reported chainId 1952.

**Tempo Moderato (42431) — special-cased, do not deploy with the generic flow.** Tempo has **no
native gas token**: fees are **USD-denominated and paid in TIP-20 stablecoins** (per docs.tempo.xyz,
confirmed on-chain 2026-06-17 — `eth_getBalance` returns a placeholder sentinel and the
`eth_gasPrice`→cost estimate is meaningless). The generic native-gas deploy can't pay fees there, so
Tempo is excluded from bare deploys (not a cost-ceiling issue). Deploying to Tempo needs a dedicated
**stablecoin fee-token** path (specify a TIP-20 as the fee currency) — a separate piece of work if we target it.
Its explorer also uses a non-Etherscan OpenAPI/Scalar verification API, so verification there is manual.

**High-gas chains** — some testnets quote anomalously high gas (e.g. Celo Sepolia ~52 gwei → ~0.8
native per deploy). On testnet the native token is valueless, so this just means you need an
awkwardly large faucet amount; it can also flag unusual fee economics worth checking before
relying on that chain.

## KNOWN, deploy PENDING — owner-requested testnets (config-ready, NOT yet deployed)

These are chains the owner holds testnet gas on and asked Access0x1 to "know" so the SDK + scaffold
can target them. They are **config-only / deploy PENDING**: chain id + name + public RPC + explorer
are facts (below); the `Router` is intentionally blank — there is **no deployed address yet**, and we
never invent one (law #4). The owner runs the CREATE3 mirror deploy + verify per chain (see
[`MIRROR-CUTOVER.md`](MIRROR-CUTOVER.md) and the owner checklist) before any address exists.

The **USDC** column is blank because no Circle-issued USDC was first-party-confirmed on these
testnets at write time — a chain ships a **bare** router/stack (or an adapter-priced one) until a real
token + price source is wired, never a placeholder.

| Chain | id | Public RPC | Explorer | Native gas | Oracle situation (pricing path) |
|---|---|---|---|---|---|
| 0G Galileo Testnet | 16602 | `https://evmrpc-testnet.0g.ai` | `https://chainscan-galileo.0g.ai` | `0G` | **No Chainlink/Pyth feed published** → bare deploy; USD pricing needs the swappable `PriceOracleAdapter` (or a `$1` USDC/USD mock) once a token + source exist. |
| Monad Testnet | 10143 | `https://testnet-rpc.monad.xyz` | `https://testnet.monadexplorer.com` | `MON` | **Chainlink push feeds LIVE** (ETH/USD + USDC/USD per Monad docs) → Router prices USD→token directly, **no adapter needed**. Owner reads exact aggregators from `docs.chain.link` at deploy. |
| Berachain Bepolia | 80069 | `https://bepolia.rpc.berachain.com` | `https://bepolia.beratrail.io` | `BERA` | On Chainlink's faucet list but **no verified push price feed** → use the `PriceOracleAdapter` (Pyth) or a `$1` USDC/USD mock until a feed is confirmed. |
| Sei Testnet (atlantic-2) | 1328 | `https://evm-rpc-testnet.sei-apis.com` | `https://testnet.seitrace.com` | `SEI` | **Pyth is the native oracle on Sei** → price via the `PriceOracleAdapter` (Pyth), **not** Chainlink. |
| MegaETH Testnet | 6342 | `https://carrot.megaeth.com/rpc` | `https://megaexplorer.xyz` | `ETH` | **No Chainlink/Pyth feed confirmed** → bare deploy; USD pricing needs the `PriceOracleAdapter` once a source is wired. |

> **Why the oracle column matters.** Access0x1's `Access0x1Router` prices a USD-denominated charge into
> the pay-in token via a **Chainlink** `AggregatorV3` feed. A chain WITHOUT a Chainlink ETH/USD (or
> native/USD) feed cannot price directly — it must route through the swappable `PriceOracleAdapter`
> (the Pyth/oracle seam) or run unpriced (token-amount only). Of the five, **only Monad has live
> Chainlink push feeds today**; 0G / Berachain / Sei / MegaETH take the adapter (Pyth) or bare path.
>
> **Sources (first-party, verified 2026-06-28):** 0G — `docs.0g.ai` testnet overview (chainId 16602,
> RPC, explorer, gas token `0G`). Monad — `docs.monad.xyz` network-info + oracles page (chainId 10143;
> Chainlink push ETH/USD + USDC/USD listed). Berachain — `docs.berachain.com` (Bepolia chainId 80069).
> Sei — `docs.sei.io` dev-chains (atlantic-2 chainId 1328) + Pyth-native oracle. MegaETH — `docs.megaeth.com`
> testnet (chainId 6342). No on-chain Access0x1 address is asserted for any of them.

## Paste-ready `.env` (verified public addresses — not secrets)

```sh
# ── verified on-chain 2026-06-17 (Circle + Chainlink official sources) ──
SEPOLIA_USDC_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
SEPOLIA_NATIVE_USD_FEED=0x694AA1769357215DE4FAC081bf1f309aDC325306
SEPOLIA_USDC_USD_FEED=0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E
ARBITRUM_SEPOLIA_USDC_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
ARBITRUM_SEPOLIA_NATIVE_USD_FEED=0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165
ARBITRUM_SEPOLIA_USDC_USD_FEED=0x0153002d20B96532C639313c2d54c3dA09109309
OPTIMISM_SEPOLIA_USDC_ADDRESS=0x5fd84259d66Cd46123540766Be93DFE6D43130D7
OPTIMISM_SEPOLIA_NATIVE_USD_FEED=0x61Ec26aA57019C486B10502285c5A3D4A4750AD7
OPTIMISM_SEPOLIA_USDC_USD_FEED=0x6e44e50E3cc14DD16e01C590DC1d7020cb36eD4C
ZKSYNC_SEPOLIA_USDC_ADDRESS=0xAe045DE5638162fa134807Cb558E15A3F5A7F853
ZKSYNC_SEPOLIA_NATIVE_USD_FEED=0xfEefF7c3fB57d18C5C6Cdd71e45D2D0b4F9377bF
ZKSYNC_SEPOLIA_USDC_USD_FEED=0x1844478CA634f3a762a2E71E3386837Bd50C947F
POLYGON_AMOY_USDC_ADDRESS=0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582
POLYGON_AMOY_USDC_USD_FEED=0x1b8739bB4CdF0089d07097A9Ae5Bd274b29C6F16
AVALANCHE_FUJI_USDC_ADDRESS=0x5425890298aed601595a70AB815c96711a31Bc65
AVALANCHE_FUJI_NATIVE_USD_FEED=0x5498BB86BC934c8D34FDA08E81D444153d0D06aD
AVALANCHE_FUJI_USDC_USD_FEED=0x97FE42a7E96640D932bbc0e1580c73E705A8EB73
BNB_TESTNET_NATIVE_USD_FEED=0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526
BNB_TESTNET_USDC_USD_FEED=0x90c069C4538adAc136E051052E14c1cD799C41B7
SCROLL_SEPOLIA_NATIVE_USD_FEED=0x59F1ec1f10bD7eD9B938431086bC1D9e233ECf41
SCROLL_SEPOLIA_USDC_USD_FEED=0xFadA8b0737D4A3AE7118918B7E69E689034c0127
LINEA_SEPOLIA_USDC_ADDRESS=0xFEce4462D57bD51A6A552365A011b95f0E16d9B7
UNICHAIN_SEPOLIA_USDC_ADDRESS=0x31d0220469e10c4E71834a79b1f276d740d3768F
WORLDCHAIN_SEPOLIA_USDC_ADDRESS=0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88
CELO_SEPOLIA_USDC_ADDRESS=0x01C5C0122039549AD1493B8220cABEdD739BC44E
# (still required per chain: <CHAIN>_PLATFORM_TREASURY = your wallet, and the *SCAN_API_KEY for verify)
```

All 23 testnet RPCs (the 20 named branches + Ethereum/Arbitrum/Optimism Sepolia) were confirmed
live with a matching `eth_chainId` on 2026-06-17.
