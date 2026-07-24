# Vendored reference docs — 0G + x402

Faithful, offline copies of the 0G and x402 developer documentation, compiled
2026-07-22 by research agents from the **open-source sources** (the 0G docs live at
`github.com/0glabs/0g-doc`; docs.0g.ai itself is Cloudflare-gated). Every file cites
its sources and marks anything unverified with **⚠️**. **Re-verify ⚠️ lines and all
addresses/model-ids against the live docs before relying on them** — testnet values
change.

These are grounding context for the build (and for a 0G AI agent / Claude session).
They are kept **out of** access0x1's own `docs/` corpus, so the CI gate is untouched.

| File | Covers |
| --- | --- |
| [`0G-COMPUTE.md`](./0G-COMPUTE.md) | Compute Network, the Router (`router-api.0g.ai/v1`, `sk-`/`mk-` keys), Inference SDK/broker, **TEE trust modes** (`X-0G-Provider-Trust-Mode: private`) + attestation, fine-tuning |
| [`0G-STORAGE-DA.md`](./0G-STORAGE-DA.md) | Storage (`@0gfoundation/0g-storage-ts-sdk`, root-hash upload/download, KV, encryption) + Data Availability |
| [`0G-CHAIN.md`](./0G-CHAIN.md) | Galileo testnet (16602) + mainnet (16661), RPC/explorer/faucet, deploy guides, precompiles |
| [`0G-AGENTIC-ID.md`](./0G-AGENTIC-ID.md) | Agentic ID, INFT/ERC-7857, ERC-8004, the 0G×AIverse agent marketplace |
| [`X402.md`](./X402.md) | x402 protocol — **v1 vs v2** packages/headers, EIP-3009/Permit2, facilitators, Base Sepolia USDC |

## The facts that pin the build

- **Provider seam:** default Claude; the `0g` adapter calls the **Router** at
  `https://router-api.0g.ai/v1` (mainnet) with `Authorization: Bearer sk-…`, model
  from `GET /v1/models` (e.g. `zai-org/GLM-5-FP8`). Funded in native **0G** token.
- **Private routing = one header.** For privacy-sensitive requests set
  **`X-0G-Provider-Trust-Mode: private`** → routes to TeeML providers only (runs in
  the TEE, prompts never leave the enclave). This is the mechanism for our per-request
  "route to 0G TEE" design.
- **Attestation** is verifiable via the `ZG-Res-Key` response header +
  `broker.inference.processResponse(...)` / `verifyService(...)` — that's the
  `AI-ATTESTATION` receipt.
- **x402 is v2.** access0x1's `PAYMENT-REQUIRED`/`PAYMENT-RESPONSE`/`payment-signature`
  are v2 semantics (v1 used `X-PAYMENT`). Base Sepolia USDC =
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (EIP-712 name `USDC`, version `2`),
  testnet facilitator `https://x402.org/facilitator`. **No 0G-chain facilitator** →
  settle on Base Sepolia.
- **Token symbol is `0G`** (not `OG`); no 0G-native USDC exists.
- **SDK scopes moved to `@0gfoundation/*`** (`@0glabs/*` is deprecated).
