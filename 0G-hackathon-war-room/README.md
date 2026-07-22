# access0x1-0g

> ## Bots a business can run for the rest of its life — trustless and permissionless.

**Private hackathon build — Lisbon 0G AI Builder Day.** A Claude-powered
(0G-swappable) x402 agent that is **identified, private, paid, bounded, and
un-extractable** — the trust layer that makes an autonomous agent safe to transact
with, and eventually to own and trade. Designed to fold into
[access0x1](https://github.com/Access0x1/Access0x1).

This README is the build brief. Read it before writing code — you (the 0G AI builder
or a Claude session) build on branch `0g-dev`.

---

## The thesis (why this exists)

Trust in autonomous AI agents is low. We fix that by making every agent action
provable across five pillars — each already a piece of this build:

| Pillar | Meaning | Built from |
| --- | --- | --- |
| **Identified** | who the agent is / that a human backs it | World ID gate + 0G Agentic ID |
| **Private** | it ran the stated model, privately | 0G TEE + attestation |
| **Paid** | it paid, verifiably | x402 receipts (+ 0G Storage) |
| **Bounded** | it stayed within limits | AP2 mandates + session caps + human-in-the-loop |
| **Un-extractable** | it wasn't front-run / sandwiched | MEV-safe, fail-closed settlement |

**The payoff:** an agent that is all five can be **sold and traded** — a
revenue-producing asset with a provable history. That's access0x1's RWA rails
pointed at agents.

## What we're building

An AI agent whose requests are paid for with **x402** (HTTP-402 USDC micropayments),
in **both directions** (it earns AND spends). The model backend is **swappable behind
a provider seam** — **Claude (Anthropic) is the default**; **0G Compute is a swap**,
routable per-request to 0G's private TEE.

```
User ─POST→ /api/premium/agent      (x402 SELLER: caller pays USDC once)
                   │ settle OK
                   ▼
           AI provider seam  (AI_PROVIDER=claude → Anthropic SDK  |  =0g → 0G Router/TEE)
                   │ needs a priced tool/dataset?
                   ▼
           /api/agent/pay     (x402 BUYER: agent autonomously pays USDC)
                   ▼
           streamed answer + PAYMENT-RESPONSE (+ optional AI-ATTESTATION) receipt
```

> **"OpenAI-compatible" ≠ OpenAI.** It's only the wire format (`POST
> /v1/chat/completions`, Bearer key) the 0G Router speaks to serve open models.
> Claude uses the Anthropic SDK. Neither OpenAI the company nor its models are used.

## Core design rules

- **Use it, don't depend on it.** Every 0G capability and external tool is additive,
  opt-in, and **fail-open** — except the money path.
- **The money path fails CLOSED.** x402/USDC settlement is swap-free and low-MEV; any
  value swap goes through a private RPC and **reverts** rather than fill a bad price.
- **Secrets are server-only; fail soft** (503 `not_configured`) when a key is unset.
- **Never claim what didn't happen** — no invented address/price/model id; a priced
  endpoint always charges > 0; money paths surface 402/500, never a silent 200.

## Stack

Next.js (App Router) + TypeScript + npm. `web/` is the app.

## Reusable seams (port from access0x1 — don't re-invent)

- **x402 seller** — `withGateway(handler, price, endpoint, chainId)` (`web/lib/x402.ts`); chain is pure env.
- **x402 buyer** — `POST /api/agent/pay` + `packages/x402-client` (budget caps, SSRF allowlist, autonomous settle).
- **AI route + provider infra** — `/api/docs-ask` pattern + `web/lib/ai/` (server-only key, globalThis meters, GET `{configured}` probe).
- **Human-in-the-loop** — `web/lib/worldid/*` (gate, execution rights, session caps) + AP2 mandates (`web/lib/ap2/mandate.ts`).
- **Ownership / RWA** — `src/Access0x1Nft.sol`, `src/Access0x1ProvenanceRegistry.sol`, `src/RwaShareVault.sol`, `src/Receivables.sol`, `src/HouseToken*.sol`.
- **Docs corpus** — `docs/*.md` auto-ingested into a grounding system prompt.

## Branch flow

`0g/agent/<slug>` off `0g-dev` → PR into `0g-dev` (integration) → PR into `0g-main`
(staging) → PR into `main`. Gate green before every promotion:
`npm run typecheck && npm run lint && npm test && npm run build`.

## Build prompts (staged — one PR each into `0g-dev`)

> **The one law (see `BUILD-PROTOCOL.md`): ONE thing at a time, strictly.** Build the
> smallest slice → **verify** it works end-to-end (gate green + proven behavior, never
> "should work") → push one PR → checkpoint → only then the next. Core (Prompt 1) is
> fully done and verified before any stretch. Test the major steps. Never two things
> at once.

**Prompt 1 — CORE: provider seam (Claude default, 0G swap) + x402 gate.** Provider
seam in `web/lib/ai/`: `streamChat({system, question, private?}) → {stream,
attestation?}`, default `AI_PROVIDER=claude`, per-request `private:true` → 0G TEE,
**fail-open** to default. `claude` adapter = `@anthropic-ai/sdk` / `CLAUDE_API_KEY` /
`CLAUDE_MODEL`. `0g` adapter = `fetch` to `${OG_COMPUTE_BASE_URL}/chat/completions`,
Bearer `OG_COMPUTE_API_KEY`, model `OG_COMPUTE_MODEL` (from env). Add `POST
/api/premium/agent` (grounded, metered, GET `{configured}` probe) wrapped with
`withGateway(...)`; echo any TEE attestation as `AI-ATTESTATION`. UI at `/agent`.
Tests mock both adapters.

**Prompt 2 — STRETCH: buyer loop.** From the handler, pay an allowlisted priced tool
via `POST /api/agent/pay`; surface its receipt (earn-and-spend in one request).

**Prompt 3 — STRETCH: 0G chain / 0G Storage.** If a 0G x402 facilitator exists (16602)
set `NEXT_PUBLIC_X402_*_16602`; else stay Base Sepolia (84532). Pin receipts + TEE
attestations to 0G Storage by root hash, fail-soft.

**Prompt 4 — STRETCH: human-in-the-loop.** Per-customer approval threshold; at/above
it return `402 HumanApprovalRequired`, proceed only after a mandate/World ID confirm.
OFF by default.

**Prompt 5 — STRETCH: MEV-safe swap.** Route value swaps through `MEV_PROTECT_RPC_URL`
with slippage + deadline bounds; **fail closed** — revert rather than fill unprotected.

## Env (event-day setup, no code)

`AI_PROVIDER` (default `claude`) · `CLAUDE_API_KEY` · `CLAUDE_MODEL` ·
`OG_COMPUTE_API_KEY` · `OG_COMPUTE_BASE_URL` · `OG_COMPUTE_MODEL` · `SELLER_ADDRESS` ·
`AGENT_X402_CHAIN_ID` (84532 default) · `NEXT_PUBLIC_X402_*_<chainId>` · `AGENT_PRICE_USD` ·
`AGENT_INTERNAL_SECRET` · `AGENT_URL_ALLOWLIST` · `AGENT_DAILY_USD_CAP` · `MEV_PROTECT_RPC_URL`.

## Verify

Gate green. Unkeyed → `{configured:false}` + disabled `/agent`. Swap test: `claude`
and `0g` both stream. Keyed → no-payment request 402; valid x402 payment → streamed
answer + `PAYMENT-RESPONSE` (+ `AI-ATTESTATION` on 0G). Buyer loop shows a settled
`/api/agent/pay` receipt.

## To confirm at the booth (see EVENT-NOTES)

0G Router model id + SSE shape · TEE attestation format + verification · 0G Storage
SDK + endpoint · Galileo RPC/explorer/faucet · whether a 0G x402 facilitator exists ·
Base Sepolia USDC + facilitator URL.

## Out of scope / stance

- **Do NOT adopt OpenClaw** as the agent runtime — keep the runtime ours.
- **AgentPad / launchpads** = optional future *marketplace/distribution* surface only.
- **Alignment nodes** = 0G's verification layer we consume, not a build task.
