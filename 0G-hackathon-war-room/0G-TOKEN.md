# 0G token (0G / "Zero Gravity") — price + role

**Snapshot: 2026-07-22.** Prices are volatile — re-check live before quoting on stage.

## Price snapshot
- **Price:** ~**$0.18 USD** (sources: $0.1824 CMC / $0.1843 CoinGecko)
- **Market cap:** ~$39M · **Rank:** ~#472–500
- **Circulating supply:** ~213M 0G · **24h vol:** ~$13–14M
- **ATH:** $7.05 · **ATL:** $0.1667 (trading ~97% below ATH)
- Ticker `0G` (some exchanges label the gas token `OG`). CMC page: "zero-gravity".

Sources: [CoinMarketCap](https://coinmarketcap.com/currencies/zero-gravity/) ·
[CoinGecko](https://www.coingecko.com/en/coins/0g) ·
[Kraken](https://www.kraken.com/prices/0g)

## What the token does in our build
- **Funds 0G Compute** — you deposit native 0G into the Router payment contract; inference is billed per-token against that balance (see `docs/0G-COMPUTE.md`).
- **Gas on 0G Chain** — pays transaction gas on Galileo/mainnet.
- **Node emissions / staking** — rewards AI Alignment Node license holders (~15% of supply).

## Honest note for the demo
The hackathon build runs on **testnet**: 0G Compute is funded with **test-OG from the faucet (free)**, and x402/USDC settlement is on **Base Sepolia**. So the live 0G price does **not** affect what the demo costs — it's **context/pitch**, not a build expense. Only mainnet usage would spend real 0G.
