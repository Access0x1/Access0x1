# 0G Compute — vendored reference

> Source: 0G docs (docs.0g.ai) + GitHub, compiled 2026-07. ⚠️ = verify against live docs.

This file is a faithful vendored copy of the 0G Compute Network developer documentation. Primary sources are the open-source docs in [`0glabs/0g-doc`](https://github.com/0glabs/0g-doc) (fetched via `raw.githubusercontent.com`), the [`0gfoundation/0g-compute-ts-starter-kit`](https://github.com/0gfoundation/0g-compute-ts-starter-kit) README, the npm registry, and the 0G/Phala blogs. Endpoints, contract/provider addresses, package names, model IDs, and CLI commands are preserved exactly. Anything not directly confirmable from a primary source is marked **⚠️ UNCONFIRMED**.

---

## 1. Overview & Concepts

*Source: [`docs/concepts/compute.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/concepts/compute.md), [`docs/developer-hub/building-on-0g/compute-network/overview.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/overview.md)*

**0G Compute** is a decentralized GPU marketplace for AI compute — "Uber for GPUs" — matching idle GPU supply with AI-developer demand. It is a core part of 0G's decentralized AI operating system (deAIOS). Instead of renting from centralized clouds with high costs and vendor lock-in, you access a global GPU network on pay-per-use pricing.

**Network components:**
1. **Smart Contracts** — handle payments (escrow) and verification.
2. **Provider Network** — GPU owners running compute services.
3. **Client SDKs** — developer integration.
4. **Verification Layer** — ensures computation integrity (TEE / cryptographic signatures).

**Supported services:**

| Service Type | What It Does | Status |
|---|---|---|
| **Inference** | Run pre-trained models (LLMs, image, speech) | ✅ Live |
| **Fine-tuning** | Fine-tune models with your data | ✅ Live |
| **Training** | Train models from scratch | 🔜 Coming |

**Trust model:** Smart-contract escrow (funds held until service delivered, automatic settlement), signed transactions (cryptographic verification of all interactions), and TEE-based verifiable computation. The docs state support for "TEEML, OPML & ZKML" verification approaches; in current practice inference providers use TEE-based verification (see §4).

**Two integration paths for consumers:**
- **Router** (recommended) — one OpenAI-compatible endpoint, one API key, one unified on-chain balance, automatic provider failover. Inference only. → §2
- **Direct** — connect to individual providers via the TypeScript SDK, per-provider sub-accounts, wallet-signed requests. Needed for browser dApps with wallet signing, on-chain control, and **fine-tuning** (Router is inference-only). → §3

---

## 2. The Router

*Source: [`.../compute-network/router/overview.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/router/overview.md), [`.../router/quickstart.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/router/quickstart.md), [`.../router/authentication.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/router/authentication.md), [`.../router/models.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/router/models.md), [`.../router/routing.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/router/routing.md)*

The **0G Compute Router** is an API gateway in front of the entire 0G Compute Network — one endpoint, one API key, every model. It handles provider discovery, on-chain billing, authentication, and failover automatically, so you use decentralized inference with the same code you'd write for OpenAI or Anthropic.

### 2.1 Base URLs

Mainnet and testnet are fully separate environments (different Web UI, endpoint, on-chain balances, and API keys).

| Network | Web UI | API Endpoint |
|---|---|---|
| **Mainnet** | [pc.0g.ai](https://pc.0g.ai) | `https://router-api.0g.ai/v1` |
| **Testnet** | [pc.testnet.0g.ai](https://pc.testnet.0g.ai) | `https://router-api-testnet.integratenetwork.work/v1` |

Full REST reference: **https://0gfoundation.github.io/0g-router/**

### 2.2 OpenAI compatibility

Any OpenAI client library — `openai-python`, `openai-node`, LangChain, LlamaIndex, Vercel AI SDK, etc. — works by changing only `base_url` → `https://router-api.0g.ai/v1` and `api_key` → your Router key. Provides OpenAI-compatible `/v1/chat/completions` with streaming, tool calling, and reasoning tokens. The Router is also described as "OpenAI / Anthropic compatible" (`/v1/messages` is referenced as a chat endpoint in the routing docs).

### 2.3 Getting an API key (pc.0g.ai)

1. Visit **[pc.0g.ai](https://pc.0g.ai)** and connect a wallet. MetaMask and WalletConnect work directly; you can also sign in with Google, X/Twitter, Discord, or TikTok via Privy, which provisions an embedded wallet.
2. **Deposit 0G tokens** to the Router's on-chain payment contract (balance lives on-chain, debited per request).
3. In **Dashboard → API Keys**, click **Create**. You receive a secret starting with `sk-`. It is shown **once** — store it safely (the dashboard stores only a hash).

No KYC, no minimum deposit gate, no waitlist.

### 2.4 Deposit / funding

- You pay in **0G tokens**, native to the 0G chain. Deposit once to the Router payment contract; the Router handles conversions and provider payouts.
- The Router bills on-chain and settles periodically in batches; there are **no subscriptions** and **no Router markup** on top of provider prices.
- The Router **payment pool is separate** from the Direct-flow per-provider sub-accounts (§3). A Router deposit does not fund sub-accounts and vice versa — different contracts. On pc.0g.ai the default view is "Router"; toggle to "Advanced" (top-right) to see the Direct/sub-account pool. Funds previously deposited on `compute-marketplace.0g.ai` live in the Direct pool.

### 2.5 Authentication (Bearer)

The Router accepts two credential types, distinguished by prefix, both sent as `Authorization: Bearer …`:

| Key type | Prefix | Purpose |
|---|---|---|
| **API key** | `sk-` | Call inference endpoints (`/v1/chat/completions`, etc.). Billed against your deposit. |
| **Management key** | `mk-` | Administer the account: list/create/revoke API keys, read balance & usage. Not billed. |

```
Authorization: Bearer sk-YOUR_API_KEY
Authorization: Bearer mk-YOUR_MANAGEMENT_KEY
```

> ⚠️ Breaking change (existing users): `sk-` keys no longer have access to `/v1/account/*` (balance, usage, history). Use an `mk-` key with the `account:read` scope.

**Permission matrix** (`✅` allowed, `❌` → `403 insufficient_scope`):

| Scenario | Endpoint | `sk-` | `mk-` |
|---|---|:--:|:--|
| Run inference | `POST /v1/chat/completions` (etc.) | ✅ | ❌ |
| Read balance / usage / history | `GET /v1/account/*` | ❌ | ✅ `account:read` |
| List API keys | `GET /v1/api-keys` | ❌ | ✅ `keys:read` |
| Create API key | `POST /v1/api-keys` | ❌ | ✅ `keys:create` |
| Edit / revoke API key | `PATCH`/`DELETE /v1/api-keys/:id` | ❌ | ✅ `keys:manage` |
| Manage management keys | `ANY /v1/management-keys/*` | ❌ | ❌ — wallet JWT only |

- Management keys cannot manage other management keys (`/v1/management-keys/*` requires the wallet sign-in JWT).
- `keys:manage` (revoke) and `keys:create` (issue) are deliberately split.

**Permission tiers** — management-key presets (created at pc.0g.ai → Settings → Management Keys):
- **Read-only** — `account:read`, `keys:read` (dashboards, monitoring).
- **Key Manager** — `keys:read`, `keys:manage` (rotate/revoke, no issuance).
- **Full Admin** — all four scopes (CI that provisions per-deploy API keys).
- **Custom** — any subset.

> Never ship `sk-`/`mk-` keys to browsers — proxy client requests through your own backend.

### 2.6 Listing models — `GET /v1/models` (no auth)

```bash
curl https://router-api.0g.ai/v1/models
```

Returns OpenAI list format:

```json
{
  "object": "list",
  "data": [
    {
      "id": "zai-org/GLM-5-FP8",
      "object": "model",
      "owned_by": "0G Foundation",
      "name": "zai-org/GLM-5-FP8",
      "context_length": 131072,
      "pricing": {
        "prompt": "100000000000",
        "completion": "320000000000"
      },
      "provider_count": 3
    }
  ]
}
```

Prices are in **neuron per token** (1e18 neuron = 1 0G). Capability flags (streaming, tool calling, vision, JSON mode) are shown per model card and in the API payload — sending `tools` to a model that doesn't support it returns `400 Bad Request`.

**List providers for a model:**

```bash
curl "https://router-api.0g.ai/v1/providers?model=zai-org/GLM-5-FP8"
```

Returns every TEE-acknowledged provider serving that model, with on-chain address, observed latency, and TEE attestation info. Query params: `model`, `service_type` (e.g. `chatbot`, `text-to-image`, `speech-to-text`). (The routing doc also references `GET /v1/providers?model_id=…` — ⚠️ both `model` and `model_id` appear in the docs; verify the exact param name against the live API reference.)

### 2.7 Provider routing options

Default behavior (no routing headers): round-robin across healthy providers with automatic failover; `503` if every provider failed. The Router never falls back to a **different model** — picking a model is your decision (`503 no_providers_available`).

Routing is controlled via **`X-0G-Provider-*` request headers** (canonical; a legacy JSON-body `provider: {…}` object is deprecated but still works on JSON endpoints — header wins on conflict).

| Header | Values | Description |
|---|---|---|
| `X-0G-Provider-Address` | on-chain address (`0x…`) | Pin to a specific provider. Implies `Allow-Fallbacks: false` unless overridden. |
| `X-0G-Provider-Sort` | `latency` \| `price` | Sort strategy when no address pinned. Ignored if address is set. Other values → `400 invalid_provider_header`. |
| `X-0G-Provider-Trust-Mode` | `standard` \| `verified` \| `private` | Restrict to a trust tier (see §4). Other values → `400 invalid_trust_mode`. |
| `X-0G-Provider-Allow-Fallbacks` | `true` \| `false` | Allow cross-provider retry. Default `true`, but `false` when address is pinned. |
| `X-0G-Provider-Max-Price-Usd-Prompt` | non-negative decimal | Ceiling on prompt price, USD per 1M tokens. |
| `X-0G-Provider-Max-Price-Usd-Completion` | non-negative decimal | Ceiling on completion price, USD per 1M tokens. |
| `X-0G-Provider-Max-Price-Usd-Image` | non-negative decimal | Ceiling on image price, USD per generated image. |

The `Max-Price` headers are a **hard filter applied before sorting and failover** — a fallback can't route you to a provider you've priced out. Empty pool → `400 no_provider_within_max_price`; pinned provider over ceiling → `400 pinned_provider_exceeds_max_price`. Price ceilings are service-type aware (Image ignored on chat calls and vice versa); speech-to-text has no ceiling yet.

Examples:

```bash
# Lowest latency
curl https://router-api.0g.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-YOUR_API_KEY" \
  -H "X-0G-Provider-Sort: latency" \
  -d '{"model": "zai-org/GLM-5-FP8", "messages": [{"role": "user", "content": "Hello"}]}'

# Pin a specific provider (fallback disabled by default when pinning)
curl https://router-api.0g.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-YOUR_API_KEY" \
  -H "X-0G-Provider-Address: 0xd9966e..." \
  -H "X-0G-Provider-Allow-Fallbacks: true" \
  -d '{"model": "zai-org/GLM-5-FP8", "messages": [{"role": "user", "content": "Hello"}]}'
```

### 2.8 Quickstart — TypeScript (OpenAI client → Router)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://router-api.0g.ai/v1",
  apiKey: "sk-YOUR_API_KEY",
});

const response = await client.chat.completions.create({
  model: "zai-org/GLM-5-FP8",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

Equivalent cURL:

```bash
curl https://router-api.0g.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-YOUR_API_KEY" \
  -d '{
    "model": "zai-org/GLM-5-FP8",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

> Note: `zai-org/GLM-5-FP8` is the model ID used in the current quickstart docs. Always check the live `/v1/models` catalog — model IDs and availability change.

---

## 3. Inference SDK / Direct broker

*Source: [`.../compute-network/inference.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/inference.md), [`.../router/comparison.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/router/comparison.md), starter-kit README, npm registry*

The Direct path connects to individual providers via the TypeScript SDK, manages **per-provider sub-accounts**, and signs every request with your wallet. Use it for browser dApps with wallet signing, direct on-chain control, or fine-tuning.

### 3.1 Package names

- **Current:** `@0gfoundation/0g-compute-ts-sdk` (npm latest `0.9.0` at compile time; description "TS SDK for 0G Compute Network"). CLI binary: `0g-compute-cli`.
- **Legacy:** `@0glabs/0g-serving-broker` is **DEPRECATED** — per its npm metadata: *"renamed to @0gfoundation/0g-compute-ts-sdk. This package is a thin re-export shim for backward compatibility."* Repo: [`0gfoundation/0g-serving-user-broker`](https://github.com/0gfoundation/0g-serving-user-broker). Install the new package.

### 3.2 Install

Prerequisites: **Node.js >= 22.0.0**, a wallet with 0G tokens.

```bash
# SDK for app integration
pnpm add @0gfoundation/0g-compute-ts-sdk

# CLI / global (adds the 0g-compute-cli binary and local Web UI)
pnpm add @0gfoundation/0g-compute-ts-sdk -g
```

### 3.3 Initialize the broker

```typescript
import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

// Choose your network
const RPC_URL = process.env.NODE_ENV === 'production'
  ? "https://evmrpc.0g.ai"          // Mainnet
  : "https://evmrpc-testnet.0g.ai"; // Testnet

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const broker = await createZGComputeNetworkBroker(wallet);
```

Browser (wallet signing): use `BrowserProvider(window.ethereum)` + `provider.getSigner()`, and pass the signer to `createZGComputeNetworkBroker`. Browser bundlers need Node polyfills (e.g. `vite-plugin-node-polyfills` for `crypto`, `stream`, `util`, `buffer`, `process`).

### 3.4 Funding — `broker.ledger.depositFund`

Minimum balances:
- **Ledger creation (`depositFund`):** minimum **3 0G** initial deposit.
- **Provider sub-account:** minimum locked balance of **1 0G** to serve requests.

```typescript
// Deposit to main ledger account
await broker.ledger.depositFund(10);

// Transfer to a provider sub-account (browser must do this manually; Node auto-funds).
// This also auto-acknowledges the provider's TEE signer on-chain.
await broker.ledger.transferFund(providerAddress, 'inference', BigInt(1) * BigInt(10 ** 18));
```

In **Node.js** the SDK runs background auto-funding (periodically tops up sub-accounts from the ledger). In the **browser** you must transfer manually (auto-funding would trigger a wallet popup per transfer). **Fee settlement is delayed/batched** in the Direct flow — sub-account balance can drop suddenly when a batch settles; you're only charged for actual usage. (The Router uses a different single-balance billing path with no visible batch settlement.)

### 3.5 Provider discovery & verification

```typescript
// List all available services
const services = await broker.inference.listService();

// Filter by service type
const chatbotServices = services.filter(s => s.serviceType === 'chatbot');
const imageServices   = services.filter(s => s.serviceType === 'text-to-image');
const speechServices  = services.filter(s => s.serviceType === 'speech-to-text');

// Optional independent TEE verification (all listed providers are pre-verified by 0G)
const result = await broker.inference.verifyService(
  providerAddress,
  './reports',                         // dir to save attestation reports
  (step) => console.log(step.message)  // optional: per-step progress
);
if (result.signerVerification.allMatch && result.composeVerification.passed) {
  console.log('Automated checks passed');
}
```

`verifyService` performs automated checks (TEE signer address match: contract vs attestation report; Docker Compose hash: calculated vs event log). Full verification also needs the manual steps printed in the output — Docker image integrity via [sigstore](https://search.sigstore.dev/) and full quote verification via [dstack-verifier](https://github.com/Dstack-TEE/dstack).

### 3.6 Full inference example (chatbot) with TEE verification

```typescript
const messages = [{ role: "user", content: "Hello!" }];

// Get service metadata (endpoint + model)
const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);

// Generate single-use auth headers (wallet-signed)
const headers = await broker.inference.getRequestHeaders(providerAddress);

// Make the request
const response = await fetch(`${endpoint}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ messages, model })
});

const data = await response.json();
const answer = data.choices[0].message.content;

// Optional: verify response integrity via the provider's TEE signature.
// Prefer the ZG-Res-Key response header; fall back to data.id.
let chatID = response.headers.get("ZG-Res-Key") || response.headers.get("zg-res-key");
if (!chatID) chatID = data.id || data.chatID;
if (chatID) {
  const isValid = await broker.inference.processResponse(providerAddress, chatID);
  console.log("Response valid:", isValid);
}
```

`broker.inference.processResponse(providerAddress, chatID)` is **optional** — it verifies the response came from a genuine TEE by checking the provider's signature for that `chatID` (returns a boolean; `null` if `chatID` omitted). Text-to-image (`/images/generations`) and speech-to-text (`/audio/transcriptions`) follow the same pattern.

### 3.7 The `0g-compute-cli` and `app-sk-<secret>` auth

```bash
0g-compute-cli setup-network                 # choose testnet/mainnet
0g-compute-cli login                         # enter wallet private key when prompted

0g-compute-cli deposit --amount 10           # deposit to main account
0g-compute-cli get-account                    # check balances
0g-compute-cli transfer-fund --provider <PROVIDER_ADDRESS> --amount 1   # fund a provider sub-account

0g-compute-cli inference list-providers
0g-compute-cli inference verify --provider <PROVIDER_ADDRESS>            # print + verify TEE attestation
0g-compute-cli inference acknowledge-provider --provider <PROVIDER_ADDRESS>   # (auto on transfer-fund)

# Generate a Bearer token for direct API calls
0g-compute-cli inference get-secret --provider <PROVIDER_ADDRESS>
# → prints a token of the form: app-sk-<SECRET>

# Run a local OpenAI-compatible proxy server (default port 3000)
0g-compute-cli inference serve --provider <PROVIDER_ADDRESS> [--port 8080]

# Local Web UI (default http://localhost:3090)
0g-compute-cli ui start-web [--port 3091]
```

**`app-sk-<secret>` usage** — direct provider calls hit the provider's `/v1/proxy` prefix:

```bash
curl <service_url>/v1/proxy/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer app-sk-<YOUR_SECRET>" \
  -d '{
    "model": <service.model>,
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

```javascript
const OpenAI = require('openai');
const client = new OpenAI({
  baseURL: `${service.url}/v1/proxy`,
  apiKey: 'app-sk-<YOUR_SECRET>'
});
const completion = await client.chat.completions.create({
  model: service.model,
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' }
  ]
});
console.log(completion.choices[0].message);
```

Per-provider **rate limits** (defaults, set by each provider): 30 requests/min sustained, burst allowance of 5, 5 concurrent; over limit → `429 Too Many Requests`.

Starter kit: [`0gfoundation/0g-compute-ts-starter-kit`](https://github.com/0gfoundation/0g-compute-ts-starter-kit) (Express + TypeScript REST server, Swagger docs at `/docs`, TEE verification, automatic ledger management).

### 3.8 Known provider addresses & model IDs (from starter-kit README — subject to change)

> ⚠️ These are examples from the starter-kit README, not a live catalog. Providers join/leave and prices change — verify with `broker.inference.listService()`, `0g-compute-cli inference list-providers`, the Router `GET /v1/models`, or pc.0g.ai. Prices shown as input/output per token in OG.

**Testnet** (RPC `https://evmrpc-testnet.0g.ai`) — all TeeML:

| Model | Type | Provider address |
|---|---|---|
| `qwen/qwen-2.5-7b-instruct` | Chatbot | `0xa48f01287233509FD694a22Bf840225062E67836` |
| `openai/gpt-oss-20b` | Chatbot | `0x8e60d466FD16798Bec4868aa4CE38586D5590049` |
| `google/gemma-3-27b-it` | Chatbot | `0x69Eb5a0BD7d0f4bF39eD5CE9Bd3376c61863aE08` |

**Mainnet** (RPC `https://evmrpc.0g.ai`) — all TeeML:

| Model | Type | Provider address |
|---|---|---|
| `deepseek-ai/DeepSeek-V3.1` | Chatbot | `0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C` |
| `openai/whisper-large-v3` | Speech-to-Text | `0x36aCffCEa3CCe07cAdd1740Ad992dB16Ab324517` |
| `openai/gpt-oss-120b` | Chatbot | `0xBB3f5b0b5062CB5B3245222C5917afD1f6e13aF6` |
| `qwen/qwen2.5-vl-72b-instruct` | Chatbot (vision) | `0x4415ef5CBb415347bb18493af7cE01f225Fc0868` |
| `deepseek/deepseek-chat-v3-0324` | Chatbot | `0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0` |
| `flux-turbo` | Text-to-Image | `0xE29a72c7629815Eb480aE5b1F2dfA06f06cdF974` |
| `openai/gpt-oss-20b` | Chatbot | `0x44ba5021daDa2eDc84b4f5FC170b85F7bC51ef64` |

---

## 4. TEE / Private Compute

*Source: [`.../compute-network/overview.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/overview.md) & [`.../inference.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/inference.md) & [`.../router/routing.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/router/routing.md); [0G blog: "0G Private Computer"](https://0g.ai/blog/0g-private-computer); [Phala blog: "Phala Network and 0G Partner…"](https://phala.com/posts/phala-network-and-0g-partner-for-enhanced-confidential-ai-computing) — ⚠️ blog pages are Cloudflare-gated to direct fetch; hardware/partnership details below are from search-engine summaries and should be re-checked against the live blog.*

Every 0G Compute inference request runs inside a **Trusted Execution Environment (TEE)** — a hardware-isolated region with cryptographic attestation of exactly what code/model executed. This makes "decentralized inference" verifiable: you can confirm out-of-band that the model you asked for is the model that ran (no silent swap to a cheaper model).

### 4.1 Hardware / stack (⚠️ from blog summaries)

- **Phala Network** is 0G's confidential-compute provider. 0G integrates Phala's TEE-based SDK for the **0G Private Computer** (live at [pc.0g.ai](https://pc.0g.ai)).
- Provider hardware combines an **Intel TDX**-enabled CPU with an **NVIDIA H100 or H200 GPU** with TEE support (GPU-TEE / NVIDIA Confidential Computing).
- Built on NVIDIA Confidential Computing plus open-source **`private-ml-sdk`** and **`dstack`** (Phala's confidential-computing framework; the docs' manual-verification step points to [`Dstack-TEE/dstack`](https://github.com/Dstack-TEE/dstack)).
- Models run in Docker containers inside the GPU-TEE; responses carry Remote Attestation evidence.

### 4.2 Verification modes

Each service declares a TEE verification mode:

- **TeeML** — the AI model runs **directly inside** the TEE. Both model and computation are protected; responses are signed by the TEE's private key. Used by self-hosted models. This is the strongest tier (verifiability **and** privacy — prompts never leave the enclave).
- **TeeTLS** — the **Broker** runs inside a TEE and proxies requests to a centralized upstream LLM over HTTPS. During the TLS handshake the Broker verifies the upstream certificate against trusted CAs, captures the cert fingerprint, and bundles it with the request hash, response hash, and provider identity into a **signed routing proof** using its TEE-protected key. Proves the response genuinely came from the real provider (conceptually similar to zkTLS, with stronger privacy since the relay itself is trusted hardware).

Router **trust tiers** (`X-0G-Provider-Trust-Mode`, ordered `standard < verified < private`, act as a floor):

| Value | Routes to | Guarantee |
|---|---|---|
| `standard` | Any TEE-backed provider | TEE-backed execution; no independent verifiability method disclosed. |
| `verified` | TeeML **and** TeeTLS providers | Verifiable execution — response provably came from the real model. |
| `private` | TeeML providers only | Verifiability **and** privacy — model runs inside the TEE, prompts never leave the enclave. |

### 4.3 How the attestation / signature is returned & verified

**Router path:**
- `GET /v1/providers?model=…` returns each provider's TEE attestation info alongside its on-chain address and latency.
- Trust-mode header restricts routing to a verification tier (above). The FAQ states every provider runs inside a TEE and attests to the model it serves; the Router stores only billing metadata (token counts, model, provider, timestamp) — **not** request/response bodies.

**Direct/SDK path:**
- Provider responses carry a per-response id in the **`ZG-Res-Key`** response header (fallback: `data.id` for chatbots).
- `broker.inference.processResponse(providerAddress, chatID)` verifies the provider's TEE signature for that `chatID` (returns a boolean; `null` if `chatID` omitted).
- `broker.inference.verifyService(...)` / `0g-compute-cli inference verify` perform attestation checks: **TEE signer address match** (on-chain contract vs attestation report) and **Docker Compose hash** (calculated vs on-chain event log). Full trust additionally requires manual steps: image integrity via [sigstore](https://search.sigstore.dev/) and full quote verification via [dstack-verifier](https://github.com/Dstack-TEE/dstack).

### 4.4 Which models are TEE-backed

**All** providers on the network run inside a TEE. In the starter-kit catalog, every listed testnet and mainnet service is marked **"TeeML verifiability"**. Which specific models are available at any time, and whether a given provider is TeeML vs TeeTLS, is dynamic — **⚠️ confirm per-provider** via `GET /v1/providers?model=…`, `broker.inference.listService()`, or pc.0g.ai. There is no static list of "TEE-backed vs non-TEE" models because non-TEE inference is not offered.

---

## 5. Fine-tuning & Roadmap

*Source: [`.../compute-network/fine-tuning.md`](https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/compute-network/fine-tuning.md)*

Fine-tuning is **✅ Live** (Direct/SDK path only — the Router is inference-only). It uses the same `@0gfoundation/0g-compute-ts-sdk` / `0g-compute-cli`. Prerequisite: Node.js >= 22.0.0.

```bash
pnpm install @0gfoundation/0g-compute-ts-sdk -g
0g-compute-cli setup-network
0g-compute-cli login

# Fund the fine-tuning sub-account (must pass --service fine-tuning)
0g-compute-cli deposit --amount 3
0g-compute-cli transfer-fund --provider <PROVIDER_ADDRESS> --amount 2 --service fine-tuning

0g-compute-cli fine-tuning list-providers
0g-compute-cli fine-tuning list-models
```

**Predefined models** (available across providers): `Qwen2.5-0.5B-Instruct` (0.5 0G / M tokens, ~100 MB LoRA), `Qwen3-32B` (4 0G / M tokens, ~900 MB LoRA). Use model names **without** the `Qwen/` prefix (e.g. `--model "Qwen2.5-0.5B-Instruct"`).

**Standard training config template** (only modify values; don't add/remove params; use decimal, not scientific, notation):

```json
{
  "neftune_noise_alpha": 5,
  "num_train_epochs": 1,
  "per_device_train_batch_size": 2,
  "learning_rate": 0.0002,
  "max_steps": 3
}
```

**Dataset:** JSONL (`.jsonl`), UTF-8, ≥10 examples recommended. Three supported formats: instruction/input/output, chat `messages`, or simple `text`.

**Create a task** (dataset auto-uploads to 0G Storage; fee auto-calculated by token count):

```bash
0g-compute-cli fine-tuning create-task \
  --provider <PROVIDER_ADDRESS> \
  --model <MODEL_NAME> \
  --dataset-path <PATH_TO_DATASET> \
  --config-path <PATH_TO_CONFIG_FILE>
# → Created Task ID: <uuid>
```

Alternatively upload separately (`0g-compute-cli fine-tuning upload --data-path …` → root hash) and pass `--dataset <ROOT_HASH>`.

**Fee** = Training Fee + Storage Reserve Fee, where Training Fee = `(tokenSize / 1,000,000) × pricePerMillionTokens × trainEpochs`; Storage Reserve is fixed per model size (Qwen3-32B ≈ 0.09 0G, Qwen2.5-0.5B ≈ 0.01 0G).

**Monitor / retrieve:**

```bash
0g-compute-cli fine-tuning get-task --provider <PROVIDER_ADDRESS> --task <TASK_ID>
0g-compute-cli fine-tuning get-log  --provider <PROVIDER_ADDRESS> --task <TASK_ID>
0g-compute-cli fine-tuning acknowledge-model --provider <PROVIDER_ADDRESS> --task-id <TASK_ID> ...
0g-compute-cli fine-tuning model-usage --provider <PROVIDER_ADDRESS> --model <MODEL_NAME> --output <PATH>
```

Task status progression: `Init → SettingUp → SetUp → Training → Trained → Delivering → Delivered → UserAcknowledged → Finished` (or `Failed`). Output is a **LoRA adapter**, encrypted and stored on 0G Storage; the decryption key is shared once fees settle. Only one active task per provider at a time.

**Roadmap:** Model **training from scratch** is 🔜 Coming (per the Compute overview). The Inference SDK is currently LLM/image/speech inference + fine-tuning; additional features are planned. ⚠️ No dated roadmap is published in the docs sourced here.

---

## 6. Testnet vs Mainnet endpoints

*Source: router `overview.md`, `inference.md` (SDK network selection), starter-kit README.*

| | Testnet | Mainnet |
|---|---|---|
| **Router API** | `https://router-api-testnet.integratenetwork.work/v1` | `https://router-api.0g.ai/v1` |
| **Router / PC Web UI** | [pc.testnet.0g.ai](https://pc.testnet.0g.ai) | [pc.0g.ai](https://pc.0g.ai) |
| **EVM RPC (SDK/CLI, Direct)** | `https://evmrpc-testnet.0g.ai` | `https://evmrpc.0g.ai` |
| **Direct marketplace UI** | [compute-marketplace.0g.ai](https://compute-marketplace.0g.ai) *(⚠️ network coverage not stated)* | [compute-marketplace.0g.ai](https://compute-marketplace.0g.ai) |
| **Testnet faucet** | [faucet.0g.ai](https://faucet.0g.ai) | — |

Mainnet and testnet are fully separate: different UI, endpoint, on-chain balances, and API keys. Pick the one matching your wallet's network. The Router testnet host (`integratenetwork.work`) is unusual but is the value published in the current docs — verify against the live docs/API reference.

---

## Appendix — units, limits & error codes

- **Pricing unit:** neuron per token, `1e18 neuron = 1 0G`. Router `/v1/models` `pricing.prompt`/`pricing.completion` are neuron-per-token strings. `X-0G-Provider-Max-Price-Usd-*` headers are USD per 1M tokens (chat) / per image.
- **Minimum balances (Direct):** ledger `depositFund` ≥ 3 0G; provider sub-account ≥ 1 0G.
- **Rate limits (per provider, Direct defaults):** 30 req/min sustained, burst 5, 5 concurrent → `429`.
- **Router error codes seen in docs:** `400 invalid_provider_header`, `400 invalid_trust_mode`, `400 invalid_max_price_usd`, `400 no_provider_within_max_price`, `400 pinned_provider_exceeds_max_price`, `401 api_key_revoked`, `403 insufficient_scope`, `503 no_providers_available`. A full errors reference exists at `.../router/errors.md` (not reproduced here).
- **Router REST reference:** https://0gfoundation.github.io/0g-router/
- **Support:** [Discord](https://discord.gg/0glabs) (`#compute`), [GitHub](https://github.com/0gfoundation).

---

### Source index

- `0glabs/0g-doc` (raw.githubusercontent.com, branch `main`): `docs/concepts/compute.md`; `docs/developer-hub/building-on-0g/compute-network/{overview,inference,fine-tuning}.md`; `.../compute-network/router/{overview,quickstart,authentication,models,routing,comparison,faq,errors}.md`
- [`0gfoundation/0g-compute-ts-starter-kit`](https://github.com/0gfoundation/0g-compute-ts-starter-kit) README (provider addresses, model IDs)
- npm registry: [`@0gfoundation/0g-compute-ts-sdk`](https://www.npmjs.com/package/@0gfoundation/0g-compute-ts-sdk) (current), [`@0glabs/0g-serving-broker`](https://www.npmjs.com/package/@0glabs/0g-serving-broker) (deprecated shim)
- [0G blog — 0G Private Computer](https://0g.ai/blog/0g-private-computer); [Phala — 0G partnership](https://phala.com/posts/phala-network-and-0g-partner-for-enhanced-confidential-ai-computing) (⚠️ Cloudflare-gated; TEE hardware details via search summaries)
