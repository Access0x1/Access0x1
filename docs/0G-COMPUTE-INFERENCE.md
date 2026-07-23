# 0G Compute Inference — an Ethereum-native agent that *joins* 0G

Access0x1 agents live on **Ethereum**. An agent's identity is an ENS name plus an on-chain
`SessionGrant` spend mandate; its money is the USDC `Access0x1Router`. Nothing about an agent is
deployed to the 0G chain.

**0G is a capability the agent opts into at runtime, not a place it lives.** "Joining 0G" means an
agent's AI inference is served by [0G Compute](https://docs.0g.ai) — 0G's decentralized inference
network — instead of the default backend. The decision is reversible, per-agent, and requires no
redeploy.

## Three ways an agent decides to join 0G

All flow through one seam, `web/lib/ai/inference.ts` (`runInference`):

1. **Deployment default** — `AI_INFERENCE_PROVIDER=zerog` makes 0G the backend for every call.
2. **Per-request** — a single call passes `provider: 'zerog'`, overriding the global default. This
   is the "it can decide" hook.
3. **From the agent's own Ethereum ENS name** — the agent publishes a text record
   `com.access0x1.inference = zerog` on its ENS name, and `web/lib/ai/agentInference.ts`
   (`resolveAgentInferenceProvider`) reads it and routes accordingly. The choice thus lives in the
   agent's *Ethereum* identity, flippable by the name owner at any time — no 0G footprint at all.

Every path is env-gated and fail-soft: if 0G is not configured, `/api/ai/infer` returns
`not_configured` (503) and the default backend is used — never a crash, never a faked completion.

## Two 0G auth modes

0G Compute has **no static API key**. `web/lib/ai/inference.ts` supports both shapes:

- **key mode** (`ZEROG_COMPUTE_ENDPOINT` + `ZEROG_COMPUTE_API_KEY`) — a static Bearer key fronting
  an OpenAI-compatible endpoint (e.g. a self-hosted gateway).
- **broker mode** (`ZEROG_BROKER_PRIVATE_KEY` + `ZEROG_PROVIDER_ADDRESS`) — **native 0G Compute**.
  A funded, **operator-held** 0G wallet mints single-use, signed billing headers per request
  (`getRequestHeaders`) — the settlement proof — and settles after (`processResponse`). The request
  itself is a normal OpenAI-compatible `POST {endpoint}/chat/completions`.

> The **only** thing that ever touches the 0G chain is the operator's funded wallet, and only to
> **pay** for inference. The agent stays entirely on Ethereum.

The 0G SDK (`@0gfoundation/0g-compute-ts-sdk`) and `ethers` are **optional peer deps**, loaded via
indirect dynamic import. The repo builds and tests green without them; broker mode stays dormant
until an operator installs them and funds a wallet.

## Go live (operator runbook)

You need a **testnet** wallet holding 0G testnet tokens. A couple of 0G is plenty — inference costs
fractions of a token. Never use a real-money key.

```bash
# 1. Install the optional 0G peer deps (kept out of the app dependencies on purpose)
cd web && npm i @0gfoundation/0g-compute-ts-sdk ethers

# 2. Discover a live provider (read-only — NO key, NO funds)
node web/scripts/zerog-bootstrap.mjs discover

# 3. Fund the broker ledger from your TESTNET wallet (key read from env, never stored)
ZEROG_BROKER_PRIVATE_KEY=0x… node web/scripts/zerog-bootstrap.mjs fund 2 <providerAddress>

# 4. Print the .env.local lines to wire the app
node web/scripts/zerog-bootstrap.mjs env <providerAddress>
```

Then set (in `web/.env.local`, gitignored — **never commit the key**):

```
AI_INFERENCE_PROVIDER=zerog
ZEROG_MODE=broker
ZEROG_BROKER_PRIVATE_KEY=<your testnet wallet key>
ZEROG_PROVIDER_ADDRESS=<discovered provider>
ZEROG_BROKER_RPC_URL=https://evmrpc-testnet.0g.ai
```

Verify:

```bash
curl localhost:3000/api/ai/infer                       # → {"configured":true,"provider":"zerog"}
curl -X POST localhost:3000/api/ai/infer \
  -H 'content-type: application/json' \
  -d '{"prompt":"Say hi from 0G Compute."}'            # → {"provider":"zerog","model":…,"completion":…}
```

## Demo: the docs assistant on 0G

The **Ask-the-docs** assistant (`/api/docs-ask`, the `DocsAssistant` widget) follows the same global
inference switch. With `AI_INFERENCE_PROVIDER=zerog` the same doc-grounded corpus is answered on 0G
Compute, and every response carries an `x-inference-provider` header the UI renders as a badge —
**"Computed on 0G Compute"** vs "Answered by Claude". That badge is the visible, judge-facing proof
that inference ran on 0G. (For 0G's smaller-context models, cap the corpus with
`DOCS_CORPUS_MAX_BYTES` so the grounding prompt fits the provider's context window.)

## Scope / honesty

0G Compute is chain **16602** (Galileo testnet), the same 0G chain the router already mirrors to.
Broker method names (`createZGComputeNetworkBroker`, `getServiceMetadata`, `getRequestHeaders`,
`processResponse`, `acknowledgeProviderSigner`, `ledger.depositFund`) are verified against
`@0gfoundation/0g-compute-ts-sdk@0.9.0`. The per-request settlement in the single-shot adapter does
not thread a `chatID` (best-effort on testnet); a production integration should correlate the
response's chat id for exact billing. Everything here is testnet-only.
