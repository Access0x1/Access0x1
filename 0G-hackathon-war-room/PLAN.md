# Open `SebasTN-Rhys/access0x1-0g` (private) with the build prompt as README

## Context

Lisbon 0G AI Builder Day (6h). You'll build a 0G-AI + x402 agent app that folds
back into **access0x1**. You're driving the build from the Claude desktop app and
will let the event's 0G agent choose direction so nothing gets coded twice. **Right
now you want one thing: a private repo to hold it, with the build prompt as the
README** — the durable brief that grounds whoever builds next (0G agent or Claude
desktop).

Decisions locked: org **SebasTN-Rhys**, name **access0x1-0g**, **private**, README =
the prompt below. No app code yet.

## The action (on approval)

Creating `SebasTN-Rhys/access0x1-0g` is **blocked from this session** (the GitHub App
has push, not org-admin; the session is scoped to `access0x1/access0x1`). So the
cheapest durable home I can reach now is the **designated branch of access0x1**.

On approval I will:
1. Assemble the war room in-repo at `0G-hackathon-war-room/` — `README.md` (build
   brief), `PRESENTATION.md` (3-min template), `EVENT-NOTES.md` (research-filled),
   `PLAN.md` (this plan).
2. `git add` + commit + push to **`claude/lisbon-0g-ai-builder-plan-vnt3q8`** (NOT
   `main` — branch rules; and note `access0x1` is a **public** repo).
3. Report the branch + paths. The private repo `SebasTN-Rhys/access0x1-0g` stays the
   eventual home — move the folder there once it exists (create it from the desktop
   app / GitHub UI, or grant the App org-admin and I'll create + push it).

## README content to commit (the prompt)

```markdown
# access0x1-0g

**Private hackathon build — Lisbon 0G AI Builder Day.** A 0G-AI + x402 agent that
demonstrates agents earning and spending stablecoins, designed to fold back into
[access0x1](https://github.com/Access0x1/Access0x1). This README is the build
brief: read it before writing code, whether you're the 0G AI builder or a Claude
session.

## What we're building

An AI agent whose requests are paid for with **x402** (HTTP-402 USDC
micropayments), in **both directions**. The **model backend is swappable behind a
provider seam** — **Claude (Anthropic) is the default**; **0G Compute is a swap**,
selected by one env var (`AI_PROVIDER`). x402, meters, and UI are provider-agnostic.

```
User ─POST→ /api/premium/agent      (x402 SELLER: caller pays USDC once)
                   │ settle OK
                   ▼
           AI provider seam  (AI_PROVIDER=claude → Anthropic SDK  |  =0g → 0G Router)
                   │ needs a priced tool/dataset?
                   ▼
           /api/agent/pay     (x402 BUYER: agent autonomously pays USDC)
                   ▼
           streamed answer + PAYMENT-RESPONSE receipt
```

> **"OpenAI-compatible" ≠ OpenAI.** It's only the wire format (`POST
> /v1/chat/completions`, Bearer key) that the 0G Router speaks to serve open
> models. Claude uses the Anthropic SDK (Messages API). Neither the OpenAI company
> nor its models are used. Claude is default; 0G is the swap.

### Why 0G is the swap: TEE private compute (use it, don't depend on it)

0G's differentiator is **0G Private Compute** — inference runs inside a **TEE**
(hardware enclave), so it's **private, trustless, permissionless**: even the node
operator can't see inputs/outputs, and the enclave can emit an **attestation**
proving the stated open-source model ran unmodified. Hosted Claude/OpenAI APIs
can't offer that (you trust the vendor's word). So 0G lets access0x1 run an
**open-source Web3 model with verifiable privacy** — swapping out a proprietary,
trusted-third-party model for a verifiable one.

Design principle (the user's rule): **use 0G, don't depend on it.**
1. **Per-request routing, not a global switch.** Claude is the default workhorse.
   Privacy-sensitive requests (user secrets, wallet data, PII) route to the 0G TEE
   via a per-request flag (`private: true`, or header `x-ai-provider: 0g`);
   everything else stays on Claude.
2. **Fail-open, never fail-closed.** If 0G is unconfigured/unavailable, fall back
   to the default provider — never drop the request. 0G's privacy is used when
   present, never a hard dependency.
3. **Attestation as a receipt.** When 0G returns a TEE attestation, surface it
   alongside the x402 `PAYMENT-RESPONSE` (e.g. an `AI-ATTESTATION` header), so a
   request proves BOTH "paid" and "ran privately." Fail-soft: no attestation → omit
   it, never fake it (Law #4). Confirm the attestation shape at the booth.

### Human-in-the-loop (customer-controlled)

Customers can insert a **human approval checkpoint** into the agent's action loop —
the agent proposes, a human confirms before anything irreversible (a spend over a
threshold, a sensitive tool call) executes. This is **already half-built** in
access0x1 — reuse, don't rebuild:
- **World ID human gate** — `web/lib/worldid/agentGate.ts` (`AGENT_REQUIRE_HUMAN`,
  `HumanGateRequired`): only a verified human unlocks the agent's allowance.
- **Execution-rights / session caps** — `web/lib/worldid/agentPolicy.ts`
  (`resolveExecutionRights`, `assertWithinSessionCap`): a human-backed agent earns a
  higher cap; an unverified one gets the conservative default.
- **AP2 mandates** — `web/app/api/ap2/mandate/route.ts` + `web/lib/ap2/mandate.ts`:
  a signed, bounded authorization ("this agent may spend up to $X on Y") — the
  durable form of a human's approval.

Design: a per-customer **approval threshold**. Below it, the agent acts
autonomously (fast path). At/above it — or for any action flagged sensitive — the
agent returns a **402 `HumanApprovalRequired`** with the proposed action, and only
proceeds once a human confirms (a fresh mandate / World ID admission). Off by
default (autonomous, unchanged); opt-in per customer. It gates the ACTION, never
the money silently — a blocked action is an explicit, retryable status, never a
dropped payment (Law #5).

### Agent runtime stance: our stack, not OpenClaw

Build agents on **our own seam** — `/api/agent/pay` + `packages/x402-client` + the
World ID gates above. Do **NOT** adopt **OpenClaw** (a.k.a. Clawdbot / MoltBot): it
is a self-hosted external agent *runtime* with its own Skills/plugin model, and
bolting our agents onto it is exactly the hard dependency the "use it, don't depend
on it" rule rejects. Same rule for **AgentPad / agent launchpads**: interesting as a
future *distribution/registry* surface to LIST or tokenize an already-built agent —
never a runtime we build on. Neither is in scope for the 6-hour build; both stay
optional, additive, and removable.

### 0G Storage (block-based, content-addressed)

0G Storage is 0G's decentralized storage layer: data is chunked into
content-addressed **blocks** (Merkle-committed), so you upload a blob and get back a
**root hash** that is its permanent, verifiable address. It pairs naturally with the
TEE + x402 story as the **durable home for proofs and memory**:
- x402 payment receipts + TEE attestations → stored by root hash = a permanent,
  tamper-evident audit trail ("paid, ran privately, here's the proof, addressed by
  hash").
- Agent memory / conversation state across sessions.
- The docs corpus itself (instead of, or alongside, the committed
  `corpus.generated.ts`).

Rule, same as the rest: **use it, don't depend on it.** Writes are fail-soft behind
an env flag — a storage error is best-effort (mirror the `recordPayment` pattern in
`web/lib/x402.ts`) and NEVER blocks the money path or the answer. Confirm the exact
0G Storage TS SDK package, indexer/endpoint URL, and the upload/download call shape
at the booth (see EVENT-NOTES).

### MEV safety (the money path fails CLOSED)

Unlike compute/storage (fail-open, additive), the money path must be **safe from
MEV** — front-running, sandwiching, extraction on value-bearing transactions.
- **Keep the hot path swap-free.** x402/USDC settlement is a fixed-amount EIP-3009
  `transferWithAuthorization` submitted by the facilitator — no AMM swap, no
  slippage, no price to sandwich. It is already inherently low-MEV; keep it that way.
- **MEV enters only on a swap leg or public-mempool settlement.** The any-token path
  (`web/lib/agent/anyTokenQuote.ts` → a DEX swap to reach USDC) and any settlement on
  a public mempool are the exposed surfaces.
- **Protections (required on any value swap):** private submission — Flashbots
  Protect / MEV-blocker RPC, or the chain's protected/private mempool — never a
  public mempool for a value-bearing swap; tight slippage + short deadline bounds;
  reuse the existing **private rail** (`web/app/api/agent/pay/privateRail.ts`, Unlink)
  for edge-unlinkability.
- **Fail CLOSED, not open (contrast with the compute path):** if MEV protection is
  unavailable or a fill would exceed slippage, the swap **reverts** — never fill a
  sandwiched price, never settle unprotected (Law #4/#5: no bad fill accepted
  silently). This is the one place where "unavailable" means STOP, not fall back.
- **Booth:** confirm 0G chain's MEV/mempool design (private mempool? protected RPC?
  based/fair sequencing?) — see EVENT-NOTES.

### The thesis: a trust layer for AI agents

Trust in autonomous agents is low — that's the opening. access0x1-0g is the **trust
stack** that makes it safe to let an agent transact, and every pillar is already a
piece we're building:
- **Identity** — World ID human-gate + 0G Agentic ID: *who* the agent is / that a
  human backs it.
- **Private, verifiable compute** — 0G TEE + attestation: proof it ran the stated
  model *privately*.
- **Verifiable payment** — x402 receipts, optionally pinned to 0G Storage by root
  hash: proof it *paid*.
- **Bounded authority** — AP2 mandates + session caps + human-in-the-loop: proof it
  *stayed within limits*.
- **MEV-safe execution** — protected, fail-closed settlement: proof it wasn't
  *extracted from*.

Together: an agent whose every action is **identified, private, paid, bounded, and
un-extractable.** That's the trust layer — and it's the through-line that ties the 0G
pieces and the access0x1 payments spine into one story.

### The payoff: agents as tradeable assets (agent-as-RWA)

The trust layer exists so an agent can be **sold and traded** — an agent that "goes
out and works for people" is a revenue-producing asset, and it's only sellable if a
buyer can trust what they're buying. The pieces are already here:
- **Earns** — the x402 seller gate makes the agent an income stream.
- **Portable, verifiable state on 0G Storage** — memory, config, and track record
  (x402 receipts + TEE attestations) pinned by **root hash**, so the agent (and its
  full provable history) travels with a transfer.
- **Ownership + provenance on-chain** — reuse access0x1's existing contracts:
  `src/Access0x1Nft.sol` (ownership), `src/Access0x1ProvenanceRegistry.sol`
  (provenance), and the revenue-share / RWA suite (`src/RwaShareVault.sol`,
  `src/Access0x1RwaToken.sol`, `src/HouseToken.sol` + `HouseTokenFactory`,
  `src/Receivables.sol`) to own — or own a SHARE of — the agent's cashflow.
- **Trade** = transfer the token → transfer the earning stream + the 0G Storage state
  pointer + the verifiable history. **AgentPad / a launchpad** is the optional
  *marketplace* surface to list it (distribution, still never a runtime).

Scope honesty: this is the **vision + a beyond-the-6h stretch**, not the demo. The
demo proves the trust layer (identified/private/paid/bounded/un-extractable); the
tradeable-asset framing is what that trust layer unlocks and the reason it matters.

**Durable, permissionless business agents (the "rest of their life" pitch).** Because
the agent's identity, state, and history live on-chain + 0G Storage — not locked in a
vendor account or a single API key — a business can run the *same* agent
indefinitely: it outlives any one provider, key, or platform. **Trustless** (every
action is verifiable, no trusted intermediary) and **permissionless** (no gatekeeper
to deploy, use, or transfer it). That is the difference between **owning** an agent
and **renting** a SaaS seat — and it's the direct consequence of "use it, don't
depend on it": no vendor lock-in anywhere in the stack, so nothing can switch the
agent off.

The agent **earns** USDC serving a request and **spends** USDC calling another
service. This is the access0x1 payments story in one loop.

**Honest split:** 0G supplies the AI (Compute Router; optional Storage/Chain).
USDC settles on **Base Sepolia** (the Circle/Coinbase facilitator supports Base;
0G Galileo has no known x402 facilitator — don't fake one). Settlement chain is one
env flag, so it can move if a 0G facilitator appears at the booth.

## Stack

Next.js (App Router) + TypeScript + npm. Server-only secrets, fail-soft when unset.

## Reusable seams to port from access0x1 (don't re-invent these)

access0x1 already ships battle-tested versions of most of this. Port or mirror:

- **x402 seller spine** — `withGateway(handler, price, endpoint, chainId)` wraps any
  route handler with HTTP-402 verify→settle→serve. Chain is pure env
  (`NEXT_PUBLIC_X402_{NETWORK,USDC,GATEWAY,FACILITATOR_URL}_<chainId>`).
- **x402 buyer** — `POST /api/agent/pay` + the `packages/x402-client` TS package:
  budget caps, SSRF allowlist, internal-secret auth, autonomous settle.
- **AI route pattern** — a streaming route with server-only key, per-IP + daily
  request/token meters on `globalThis`, GET `{ configured }` probe, 503
  `not_configured` when unkeyed.
- **Docs corpus** — `docs/*.md` auto-ingested into a grounding system prompt.

## Branch flow

Long-lived: `0g-dev` (integration) → `0g-main` (staging) → `main` (production).
Each task = a feature branch `0g/agent/<slug>` off `0g-dev`, PR'd into `0g-dev`.
Promote by PR only when the gate is green.

## Build prompts (staged — one PR each into `0g-dev`)

**Prepend to every prompt:**
> Work on `0g-dev`; branch `0g/agent/<slug>`, PR into `0g-dev`. Gate must pass:
> `npm run typecheck && npm run lint && npm test && npm run build`. Secrets are
> SERVER-ONLY; fail soft (503 not_configured) when a key is unset. Never invent an
> address, price, or model id. A priced endpoint always charges > 0. Money paths
> surface 402/500 — never a silent 200. Reuse the seams above; don't re-implement
> x402 or the meters.

**Prompt 1 — CORE: provider seam (Claude default, 0G swap) + x402 gate**
> First define a provider seam in `web/lib/ai/` (extend the existing `aiGateway.ts`):
> `streamChat({ system, question, private? }) → { stream: AsyncIterable<string>,
> attestation?: string }`. Provider selection: default from `AI_PROVIDER`
> (default `claude`), but a per-request `private: true` (or header
> `x-ai-provider: 0g`) routes to the 0G TEE. **Fail-open:** if the chosen provider
> is unconfigured/unavailable, fall back to the default and still answer — never
> drop the request (use 0G, don't depend on it). When the `0g` adapter returns a
> TEE attestation, pass it through so the route can echo it as an `AI-ATTESTATION`
> header (fail-soft: omit if absent, never fabricate). Two adapters:
>  - **`claude` (default):** `@anthropic-ai/sdk`, `CLAUDE_API_KEY`, model
>    `CLAUDE_MODEL` (default `claude-haiku-4-5`) — reuse the exact `/api/docs-ask`
>    streaming + cache-control pattern.
>  - **`0g` (swap):** plain `fetch` (no new dep) to
>    `${OG_COMPUTE_BASE_URL:-https://router-api.0g.ai/v1}/chat/completions`, Bearer
>    `OG_COMPUTE_API_KEY`, model `OG_COMPUTE_MODEL` (from env — never hardcode),
>    `stream:true`; parse SSE, yield `choices[0].delta.content`.
>  `configured` = the SELECTED provider's key + model are set. Adding a third
>  provider = one more adapter; the route never changes.
>
> Then add `POST /api/premium/agent` that streams via the seam, grounded on the docs
> corpus, with server-only keys, globalThis meters (new key), per-IP + daily caps,
> and an ungated GET `{ configured }` probe. Wrap the handler with the x402 seller:
> `withGateway(handler, AGENT_PRICE_USD || "$0.01", "/api/premium/agent",
> Number(AGENT_X402_CHAIN_ID) || undefined)`. Add a streaming UI page at `/agent`
> gated on the probe. Tests mock both adapters — assert not_configured 503,
> rate-limit 429, happy-path stream for EACH provider, and 402 without a payment
> header. Document env: `AI_PROVIDER`, `CLAUDE_API_KEY`, `CLAUDE_MODEL`,
> `OG_COMPUTE_API_KEY`, `OG_COMPUTE_BASE_URL`, `OG_COMPUTE_MODEL`,
> `AGENT_X402_CHAIN_ID`, `AGENT_PRICE_USD`, `SELLER_ADDRESS`.

**Prompt 2 — STRETCH: autonomous buyer loop**
> From inside the agent handler, when the model needs a priced tool, call the
> existing `POST /api/agent/pay` with `x-internal-secret: $AGENT_INTERNAL_SECRET`,
> respecting `AGENT_URL_ALLOWLIST` + the daily cap. Surface the tool's
> PAYMENT-RESPONSE receipt in the streamed answer so the demo shows earn-and-spend
> in one request. Fail soft: on budget/error, answer without the tool — never crash.

**Prompt 3 — STRETCH: 0G chain settlement / 0G Storage (only if time)**
> If a booth x402 facilitator exists for 0G Galileo (16602), set
> `NEXT_PUBLIC_X402_*_16602` and `AGENT_X402_CHAIN_ID=16602` — settlement moves to
> 0G chain with no code change; else stay on Base Sepolia (84532). Optionally persist
> each receipt + TEE attestation to 0G Storage (block-based) via the 0G TS SDK behind
> an env flag; store the blob, keep the returned root hash on the response as the
> permanent audit address. Fail-soft: a storage error never blocks the answer or the
> settlement (mirror `recordPayment` in `web/lib/x402.ts`).

**Prompt 4 — STRETCH: customer human-in-the-loop approval**
> Add a per-customer approval threshold to the agent action loop. Reuse the World
> ID gate (`web/lib/worldid/agentGate.ts`), execution-rights/session caps
> (`web/lib/worldid/agentPolicy.ts`), and AP2 mandates (`web/lib/ap2/mandate.ts`) —
> do not build a new auth system. Below the threshold the agent acts autonomously;
> at/above it (or on a sensitive-flagged action) return `402
> HumanApprovalRequired` with the proposed action, proceeding only after a human
> confirms via a fresh mandate / World ID admission. OFF by default (behavior
> unchanged); opt-in per customer via env/config. Gate the ACTION as an explicit
> retryable status — never silently drop a payment (Law #5). Tests: below-threshold
> autopays; at/above returns 402 HumanApprovalRequired; a valid mandate lets it
> proceed.

**Prompt 5 — STRETCH: MEV-safe swap/settlement leg**
> Harden any value-bearing swap (the `web/lib/agent/anyTokenQuote.ts` any-token path)
> and any public-mempool settlement against MEV. Route value swaps through a private
> submission RPC (`MEV_PROTECT_RPC_URL` — Flashbots Protect / MEV-blocker, or the
> chain's protected mempool), enforce a slippage cap + short deadline, and reuse the
> Unlink private rail (`web/app/api/agent/pay/privateRail.ts`). FAIL CLOSED: if the
> protect RPC is unset/unreachable or a fill would exceed slippage, revert — never
> fill a sandwiched price, never settle unprotected. Leave the swap-free x402/USDC
> hot path untouched (it is already low-MEV). Tests: a swap with no protect RPC
> reverts; an over-slippage fill reverts; the plain USDC path is unchanged.

## Event-day setup (env, no code)

- **Provider:** default `AI_PROVIDER=claude` — set `CLAUDE_API_KEY` (+ optional
  `CLAUDE_MODEL`). To demo the swap, set `AI_PROVIDER=0g`: connect wallet → deposit
  to the 0G Router payment contract → create an API key; set `OG_COMPUTE_API_KEY`
  and `OG_COMPUTE_MODEL` to a model id the Router lists (`GET /v1/models`).
- **x402 seller:** `SELLER_ADDRESS` (payout EOA) + `NEXT_PUBLIC_X402_*_84532` (Base
  Sepolia default); `AGENT_X402_CHAIN_ID=84532`.
- **x402 buyer:** `AGENT_INTERNAL_SECRET`, `AGENT_URL_ALLOWLIST`,
  `AGENT_DAILY_USD_CAP`, agent wallet funded with testnet USDC.
- Fund a test payer wallet with testnet USDC for the demo.

## Verify

Gate green (`typecheck / lint / test / build`). Unkeyed → GET `{ configured:false }`
and a clean disabled `/agent` widget. Test the swap: `AI_PROVIDER=claude` and
`AI_PROVIDER=0g` both stream. Keyed → no-payment request returns 402; a valid
x402 payment returns a streamed 0G answer + `PAYMENT-RESPONSE`. Buyer loop shows a
settled `/api/agent/pay` receipt inside the answer.

## Notes / risks

- 0G Galileo likely has no x402 facilitator → keep USDC on Base Sepolia; 0G supplies
  the AI. Don't claim a facilitator that isn't there.
- Confirm the exact 0G Router model id + SSE shape at the booth; the route reads the
  model from env and must not guess it.
- TEE unknowns to confirm at the booth: which models run in the TEE; the attestation
  format and how to fetch it (inline in the `/chat/completions` response vs a
  separate endpoint); how a client verifies it. The `AI-ATTESTATION` echo is
  fail-soft, so the build works before this is known — but the "verifiable privacy"
  demo needs it.
- **Do NOT adopt OpenClaw** (Clawdbot / MoltBot) as the agent runtime — keep the
  runtime ours (`/api/agent/pay`, `packages/x402-client`, World ID gates). AgentPad /
  launchpads are an optional future distribution surface, never a runtime dependency.
- Human-in-the-loop reuses the existing World ID gate + AP2 mandate primitives; it
  is OFF by default and opt-in per customer, so it never changes autonomous behavior
  unless a customer turns it on.
- **MEV: the money path fails CLOSED** (opposite of compute). The x402/USDC hot path
  is swap-free and already low-MEV; only value swaps / public-mempool settlement are
  exposed, and those require a private submission RPC — revert rather than fill a
  sandwiched price. Confirm 0G chain's mempool/MEV design at the booth.
- **Positioning:** the through-line is a **trust layer for AI agents** — identified,
  private (TEE), paid (x402), bounded (mandates + HITL), and un-extractable (MEV-safe).
- **Agent-as-asset** is the payoff/vision (sell/trade an earning agent whose state +
  history live on 0G Storage; ownership via existing `Access0x1Nft` / provenance / RWA
  contracts). Beyond the 6h demo — the demo proves the trust layer that makes it work.
- **0G AI Alignment Nodes** = 0G's own verification layer (model-drift / malicious-
  data / price-feed-mismatch detection; NFT node licenses). We CONSUME this trust
  backbone, we don't build it; their feed-mismatch check rhymes with our fail-closed
  money path. Running/owning a node is a separate ecosystem play, not a build task.
```
