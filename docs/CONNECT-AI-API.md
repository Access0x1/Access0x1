# Connect an AI API

Give an AI agent (or an MCP client) **one API key** and let it call a metered
endpoint that **pays per request** through the Access0x1 rail — budget-capped by a
`SessionGrant` and settled gas-free over **x402** on Arc Testnet. No custom
contract code: this feature is a thin composition of pieces the rail already ships.

> **Testnet only.** Payments settle real USDC on **Arc Testnet** via Circle's
> batch facilitator. Nothing here touches mainnet.

---

## What you get

```
AI agent ──Authorization: Bearer ak_…──▶  /api/ai/chat
                                          │
              1. API-key auth  ───────────┤  ak_… → SessionGrant session + price
              2. budget check  ───────────┤  reserve price on the session budget
              3. x402 settle   ───────────┤  agent wallet pays per call (gas-free)
              4. serve         ───────────┘  upstream AI runs IFF settle succeeded
```

- **One key, one budget.** A key is bound to a `SessionGrant` session. The session's
  `budgetCap` is the hard ceiling; per-call price is charged against it. A `$1.00`
  budget at `$0.001`/call affords exactly 1,000 calls, then the key is cut off.
- **Pay-per-use.** Each call is an x402 micro-payment — the existing seller spine
  (`web/lib/x402.ts`), unchanged. The agent's wallet signs an EIP-3009 authorization
  off-chain and Circle settles it in a batch. On Arc, USDC is the gas token, so the
  payer is gas-free.
- **Owner-revocable, time-bounded.** Because the budget is a `SessionGrant`, the
  owner can `revoke()` the session at any time and it expires on its own.

---

## The pieces

| File | Role |
|------|------|
| `web/lib/ai/connect.ts` | `connectAiApi(...)` — bind an API key to a SessionGrant session + per-call price. The one-call SDK surface. |
| `web/lib/ai/apiKeys.ts` | The key registry. Stores only a **hash** of each key; resolves a presented key to its session binding (constant-time). |
| `web/lib/ai/sessionMeter.ts` | The off-chain mirror of `SessionGrant.remaining()` / `spend()`. The pre-settle budget guard. |
| `web/lib/ai/aiGateway.ts` | `withAiGateway(handler, price, endpoint)` — composes key-auth + budget check + the existing `withGateway` x402 settlement. |
| `web/app/api/ai/chat/route.ts` | The connectable endpoint. After payment settles, it runs a real upstream AI completion. |
| `src/SessionGrant.sol` | The on-chain, authoritative budget ceiling (already deployed to testnets). |

---

## 1. Open a `SessionGrant` budget (on-chain)

An owner authorizes a delegate (the agent's server wallet) to spend up to a budget
until an expiry, with one signature. Either path works:

- **Owner as caller** (a 7702-delegated EOA): `SessionGrant.openSession(delegate, budgetCap, expiry)`.
- **Relayed grant** (any wallet signs off-chain, a relayer submits):
  `SessionGrant.openSessionFor(owner, delegate, budgetCap, expiry, signature)` —
  accepts ECDSA / ERC-1271 / ERC-6492, so even a counterfactual smart account can
  authorize before it has code.

The session id is `keccak256(abi.encode(owner, delegate, nonce))` — recomputable
off-chain with `computeSessionId(owner, delegate, nonce)`.

`budgetCap` and the per-call price are **6-decimal atomic USDC**: `$1.00` = `1_000_000n`,
`$0.001` = `1000n`.

SessionGrant addresses per chain are in [`docs/CHAIN-ADDRESSES.md`](./CHAIN-ADDRESSES.md)
(look for `SessionGrant` / `SessionGrant.proxy`).

## 2. Connect the AI API (issue a key)

Generate a key out of band (e.g. `ak_` + random bytes) and bind it to the session.
A deployment does this at boot or from an admin route:

```ts
import { connectAiApi } from "@/lib/ai/connect.js";

const { sessionId } = connectAiApi({
  owner:    "0xOwner…",        // SessionGrant owner
  delegate: "0xAgentWallet…",  // SessionGrant delegate (the agent)
  nonce:    0n,                // the owner nonce the grant was pinned to
  budgetCapAtomic: 1_000_000n, // $1.00 ceiling — matches the on-chain grant
  expiry:   Math.floor(Date.now() / 1000) + 86_400, // 24h, matches on-chain
  pricePerCallAtomic: 1000n,   // $0.001 per call
  apiKey: "ak_live_…",         // the key you hand the developer (never logged)
  label: "claude-haiku example",
});
```

Only the key's **hash** is stored. The plaintext is the developer's to keep.

## 3. Call the endpoint (the agent connects)

The agent points at the metered endpoint with the key. The first request gets an
HTTP-402 challenge; an x402 client pays and retries automatically.

**Raw HTTP — see the 402 challenge:**

```bash
curl -i -X POST https://<your-deployment>/api/ai/chat \
  -H "Authorization: Bearer ak_live_…" \
  -H "content-type: application/json" \
  -d '{"prompt":"Summarize x402 in one line."}'
# → 402 Payment Required, with a base64 PAYMENT-REQUIRED header (the x402 challenge)
```

**With an x402-paying agent (pays + retries):**

```ts
import { wrapFetchWithPayment } from "x402-fetch";

// `account` is your agent's signer (e.g. the Dynamic MPC wallet in
// web/lib/agent/x402Signer.ts). It signs the EIP-3009 authorization off-chain.
const payFetch = wrapFetchWithPayment(fetch, account);

const res = await payFetch("https://<your-deployment>/api/ai/chat", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ak_live_…",
    "content-type": "application/json",
  },
  body: JSON.stringify({ prompt: "Summarize x402 in one line." }),
});

const { model, completion, paid } = await res.json();
// paid === "$0.001"  — the per-call price that settled
```

This estate's own agent route (`web/app/api/agent/pay`) already drives exactly this
loop; `web/lib/agent/payPerCall.ts` is the reference buyer.

---

## Responses

| Status | Body | Meaning |
|--------|------|---------|
| `200` | `{ model, completion, paid }` | Paid + served. |
| `401` | `{ error: "Unauthorized" }` | Missing or invalid API key — **no payment attempted**. |
| `402` | `{ error: "SessionBudgetExceeded", remaining, requested }` | Budget exhausted / revoked / expired — **no payment attempted**. |
| `402` | `{ error: "Payment required", accepts: [...] }` | The x402 challenge (pay and retry). |
| `503` | `{ code: "not_configured" }` | The payment settled, but the upstream AI key is unset on this deployment (see boundary below). |

The budget and the payment are the **same amount**: a request that fails to settle
(any `402` from the inner gateway) **refunds** its budget reservation — money paths
never swallow (law #5). A request that *settles* keeps the reservation, because the
USDC moved.

---

## How the metering + cap actually work

1. **API-key auth (CEI, before money).** `Authorization: Bearer ak_…` resolves via
   `apiKeys.ts` to the bound session id + price. No/invalid key → `401`, nothing
   settles.
2. **Budget check (CEI, before money).** `sessionMeter.ts` reserves the per-call
   price against the session's remaining budget — the off-chain twin of
   `SessionGrant.remaining()`/`spend()`. Over budget / revoked / expired → `402`,
   nothing settles.
3. **x402 settle.** The unchanged `withGateway` seller spine challenges with
   HTTP-402, then Circle verifies + settles the agent's EIP-3009 authorization. The
   handler runs **iff** settle succeeds.
4. **Refund on miss.** If settle didn't happen (`402`), the budget reservation is
   released.

---

## The honest boundary (read this)

- **The x402 payment is real and on-chain** — USDC settles via Circle on Arc
  Testnet on every served call.
- **The budget is enforced at the HTTP edge against the off-chain mirror**, not by
  submitting `SessionGrant.spend()` on-chain on each call. This minimal version has
  **no relayer/signer** wired to debit the on-chain session per request. The
  on-chain `SessionGrant` remains the **authoritative** ceiling (and its `revoke()` /
  `expiry` are authoritative); the off-chain meter is a fast pre-settle guard keyed
  by the **same** session id so a runaway agent is stopped before it settles
  thousands of micro-payments. Wiring a relayer to also call `SessionGrant.spend()`
  on each settle — so the two ledgers converge on-chain — is the documented next
  step. The seam is in `sessionMeter.ts`; call sites don't change.
- **The persistence is in-process.** Keys and the budget meter live in a
  `globalThis`-pinned map (same pattern as the rest of this repo's stores). They
  reset on process restart. The `connectAiApi` / `resolveKey` / `reserveOrThrow`
  interface is the seam a durable KV/Postgres store swaps behind later.
- **The upstream AI degrades honestly.** `/api/ai/chat` calls a real model (the
  Anthropic SDK already in the repo, via the server-only `CLAUDE_API_KEY`). If that
  key is unset, the route returns `not_configured` `503` **after** the payment
  settled — it never fabricates a completion. Point the handler at any upstream API;
  the rail is provider-agnostic.

---

## Bring your own AI endpoint

`withAiGateway` wraps any handler, so you can meter any upstream:

```ts
// web/app/api/ai/<your-endpoint>/route.ts
import { withAiGateway } from "@/lib/ai/aiGateway.js";

async function handler(req: Request): Promise<Response> {
  const { input } = await req.json();
  const out = await callYourModel(input); // runs ONLY after settle
  return Response.json({ out });
}

export const POST = withAiGateway(handler, "$0.002", "/api/ai/your-endpoint");
```

The `price` is both the SessionGrant reservation and the x402 settle amount — keep
them equal so the budget ceiling and the charge line up.

---

## Environment

| Var | Used by | Notes |
|-----|---------|-------|
| `SELLER_ADDRESS` | x402 spine | The merchant payout EOA (the Gateway balance owner). Required to build payment requirements. |
| `CLAUDE_API_KEY` | `/api/ai/chat` | Server-only upstream AI key. Unset → honest `not_configured` 503 after settle. |

Keys themselves are issued via `connectAiApi(...)`, not env. See
[`docs/GETTING-STARTED.md`](./GETTING-STARTED.md) for the rail setup and
[`docs/CHAIN-ADDRESSES.md`](./CHAIN-ADDRESSES.md) for the deployed `SessionGrant`
addresses.
