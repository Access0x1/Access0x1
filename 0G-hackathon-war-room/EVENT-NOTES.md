# EVENT-NOTES.md — Lisbon 0G AI Builder Day

Facts gathered pre-event (2026-07-22). ✅ = confirmed from a primary/mirror source ·
⚠️ = **verify at booth**. Docs at docs.0g.ai are Cloudflare-gated; soft items flagged.

## 0G Compute (the `0g` provider swap)
- ✅ Router base URL: `https://router-api.0g.ai/v1` (OpenAI-compatible; `Authorization: Bearer <key>`)
- ✅ Dashboard / get API key: **`https://pc.0g.ai`** → connect wallet (or Privy social login) → deposit → create key
- ✅ Funded with native **OG** token (NOT USDC); cost deducted per-token
- ✅ Models: pull live from `GET /v1/models`. Seen: DeepSeek V3.1, Qwen, Gemma, GPT-OSS, `zai-org/GLM-5.1-FP8`
- ⚠️ Exact model id to use → read `/v1/models` at build time
- ⚠️ Router payment/deposit contract address (abstracted by pc.0g.ai)
- ✅ SSE: standard OpenAI `text/event-stream`, `data: {chat.completion.chunk}` … `data: [DONE]`
- ✅ Direct-broker alt SDK: `@0gfoundation/0g-compute-ts-sdk` (auth = `app-sk-<secret>` via `0g-compute-cli`)

## 0G Private Compute / TEE + attestation
- ✅ Inference runs in a **TEE** (Phala GPU-TEE SDK; NVIDIA GPU enclave)
- ✅ Output is **signed by the enclave key**; response carries a signature linked to attestation reports
- ⚠️ Exact wire format (header vs JSON field; inline quote vs separate fetch) — verify at booth
- ⚠️ Verifier SDK / package name — verify at booth
- ⚠️ Which specific model ids are TEE-backed — verify at booth

## x402 / settlement chain
- ✅ **No 0G x402 facilitator exists (chain 16602).** Run x402 on **Base Sepolia (84532)**
- ✅ Base Sepolia USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals)
- ✅ Testnet facilitator (no auth): `https://x402.org/facilitator`
- ✅ Packages: `x402`, `x402-next` (use for Next.js), `x402-express`, `@coinbase/x402`, `@x402/evm`
- ✅ EIP-3009 `transferWithAuthorization` (gasless); V2 adds Permit2
- ✅ Mainnet facilitator via `@coinbase/x402` CDP (`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`)
- ⚠️ `@circle-fin/x402-batching` (used in access0x1 today) — keep the repo's existing choice
- ⚠️ SELLER_ADDRESS payout wallet (your EOA): __________

## 0G Chain (Galileo testnet)
- ✅ chainId **16602** (16601 is the old/superseded id)
- ✅ RPC: `https://evmrpc-testnet.0g.ai` · Explorer: `https://chainscan-galileo.0g.ai`
- ✅ Gas token: `OG` · fully EVM-compatible (Foundry/Hardhat/ethers/viem unchanged)
- ⚠️ Faucet host (via `build.0g.ai/chain`; ~0.1 OG/day)
- ✅ **No 0G-native USDC/stablecoin found** — do not assume one

## 0G token (0G) — price snapshot (2026-07-22, volatile)
- ✅ ~**$0.18 USD** · mkt cap ~$39M · rank ~#472–500 · circ ~213M · ATH $7.05 / ATL $0.1667
- ✅ Role: funds 0G Compute (deposit → per-token billing), gas on 0G Chain, node emissions
- ➜ Demo uses **free test-OG** (faucet) + x402 on Base Sepolia → price is **pitch context, not a build cost**. Full detail in `0G-TOKEN.md`.

## 0G Storage (block-based, root-hash addressed)
- ✅ SDK: `@0glabs/0g-ts-sdk` (`npm i @0glabs/0g-ts-sdk`; peer dep `ethers`)
- ✅ Indexer (testnet): `https://indexer-storage-testnet-turbo.0g.ai` · EVM RPC `https://evmrpc-testnet.0g.ai`
- ✅ Address by **root hash** (`ZgFile` → `merkleTree()` → `rootHash()`); `Indexer.upload/download`
- ⚠️ Storage fee/cost specifics — verify at booth

## 0G Agentic ID / tradeable agents
- ✅ Agentic ID = **ERC-7857 INFT** (encrypted, transferable metadata) — compatible with **ERC-8004** (Trustless Agents: identity/reputation/validation registries)
- ✅ Ownership transfer moves the token AND the encrypted intelligence; metadata on 0G Storage
- ✅ Marketplace: **0G × AIverse** "Web 4.0 marketplace where AI agents own, trade, evolve" (announced Mar 2026; "EchoClaw" = agent economic layer)
- ⚠️ No product literally named "AgentPad"; marketplace live/testnet status — verify at booth
- ⚠️ Exact 0G Agentic-ID npm package — verify at booth (ref: `0xgasless/agent-sdk`, ERC-8004 + x402)

## AI Alignment Nodes
- ✅ Infra/verification layer: detects model drift, malicious data injection, **price-feed mismatch** pre-execution
- ✅ **No developer-facing API** — node-operator layer (NFT node licenses). Background narrative, not a call

## MEV (honesty correction)
- ✅ **Flashbots Protect does NOT support Base / Base Sepolia** (Ethereum mainnet/Sepolia/Holesky only; L2 "in progress")
- ✅ Base sequencer is centralized (Coinbase) → testnet public-mempool front-running risk is low in practice
- ➜ Options: demo a private submission on **Ethereum Sepolia** via `https://rpc-sepolia.flashbots.net`, OR present Base MEV protection as **mainnet-only** and use tight slippage+deadline on testnet. **Do not claim a Base Sepolia private RPC.**

## Decisions / demo config
- AI_PROVIDER for demo (claude | 0g): __________
- Model id from `/v1/models`: __________
- x402 chain: **84532 (Base Sepolia)** · SELLER_ADDRESS: __________
- Which stretch goals attempted: __________

## Hackathon logistics (fill at booth)
- Which 0G products MUST be used to qualify: __________
- Judging criteria / submission form / deadline: __________
- Booth contacts / Discord / starter repo: __________

## Raw notes / quotes / links
-
