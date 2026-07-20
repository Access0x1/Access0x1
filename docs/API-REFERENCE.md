# API Reference — web routes

The server-side HTTP surface of the hosted Access0x1 deployment (`web/`, Next.js 15
App Router). Every endpoint here maps one-to-one to a route file under
[`web/app/api/`](../web/app/api) — that file is the source of truth, and each row
below links to it. When this doc and the code disagree, **the code wins**; tell us
so we can fix the doc.

> **Testnet only.** Anything that settles money does so in **real USDC on Arc
> Testnet** via Circle's batch facilitator. Nothing here touches mainnet.
> (LAW #4: we never claim a capability the deployment does not actually run.)

> **Honest degrade.** Many endpoints are **booth-gated**: when an upstream
> (Claude, the World ID Developer Portal, an ENS resolver, a fiat on/off-ramp, the
> Unlink SDK) is not configured on a given deployment, the route returns a clear
> `not_configured` status (usually `503`) and **does nothing** — it never fabricates
> a result. Every endpoint's "not configured" behavior is documented below.

---

## Conventions

| Topic | Rule |
|-------|------|
| **Base URL** | All paths are relative to your deployment origin (e.g. `http://localhost:3000` in dev). Paths shown as `/api/…`. |
| **Content type** | Request and response bodies are JSON (`content-type: application/json`) unless noted. The streaming Q&A route (`/api/ask`) replies `text/plain`. |
| **Errors** | Errors are JSON. The shape is either `{ "error": "<message-or-code>" }` or `{ "error": "<Class>", "reason": "<detail>" }`. Some add a machine-readable `"code"`. **No secret, stack trace, or payout address ever appears in a response body.** |
| **Money never swallows** | A failed settlement, swap, or payout surfaces explicitly (a non-`200` or an explicit `swapped:false` / `recoverable` flag) — never a silent success. |
| **Amounts** | USDC amounts are 6-decimal. Over-the-wire on-chain amounts are decimal **strings** (e.g. `"5.000000"`) or atomic base-unit **strings** — never JS numbers (bigint is not JSON-safe). USD prices are strings like `"$0.001"`. |
| **No identity leak** | Read endpoints that take an unauthenticated `?tenantId=` query strip verification fields (World ID nullifier, verifier, required tier) from the response. |

### Authentication schemes

Different surfaces use different gates — there is no single global auth header.

| Scheme | Header | Used by |
|--------|--------|---------|
| **Dynamic JWT** (tenant identity) | `Authorization: Bearer <dynamic-jwt>` | Tenant-scoped branding writes, `gateway/withdraw`. Verified server-side against the issuer's JWKS; the verified wallet must match the acting tenant/seller. Falls back to a shape-checked body `tenantId` only when no issuer is configured (booth-gated). |
| **Access0x1 AI key** | `Authorization: Bearer ak_…` | `POST /api/ai/chat`. Resolves to a `SessionGrant` session + per-call price. |
| **x402 payment** | `payment-signature: <base64>` | The priced endpoints (`/api/ai/chat`, `/api/premium/*`). See [the x402 challenge](#the-x402-payment-challenge). |
| **Internal shared secret** | `x-internal-secret: <secret>` | Server-to-server routes (`agent/pay`, `payout-swap`, optionally `ap2/mandate`). Compared in constant time. These routes **fail closed**: with the secret unset they refuse (`503 not_configured`) unless an explicit local-dev escape hatch env is set. |

---

## The x402 payment challenge

The priced endpoints (`/api/premium/*`, and `/api/ai/chat` after key-auth) sit
behind the x402 / Circle Nanopayments seller spine
([`web/lib/x402.ts`](../web/lib/x402.ts)). The flow:

1. **No `payment-signature` header** → `402` with a JSON body
   `{ "error": "Payment required", "accepts": [<requirements>] }` and a base64
   `PAYMENT-REQUIRED` response header carrying the same requirements.
2. The payer builds and signs an EIP-3009 authorization against the Arc Gateway
   Wallet domain and retries with `payment-signature: <base64-signed-payload>`.
3. **Verify fails** → `402 { "error": "Payment verification failed", "reason": "…" }`.
4. **Settle fails** → `402 { "error": "Payment settlement failed", "reason": "…" }`.
5. **Settle succeeds** → the handler runs; the `200` response carries a base64
   `PAYMENT-RESPONSE` header with `{ success, transaction, network, payer }`.
6. **Malformed `payment-signature`** → `500 { "error": "Payment processing error", "message": "…" }`.

The `accepts[0]` payment-requirements object:

```json
{
  "scheme": "exact",
  "network": "<arc-testnet-network>",
  "asset": "<arc-testnet-usdc-address>",
  "amount": "1000",
  "payTo": "<seller-address>",
  "maxTimeoutSeconds": 345600,
  "extra": { "name": "GatewayWalletBatched", "version": "1", "verifyingContract": "<gateway-wallet>" }
}
```

`amount` is **atomic** 6-decimal USDC (`"1000"` = `$0.001`). `payTo` is the seller's
plain EOA — the protocol holds zero custody.

---

## Endpoints

| Method · Path | Auth | What it does |
|---------------|------|--------------|
| [`POST /api/ai/chat`](#post-apiaichat) | `ak_…` key + x402 | Metered, pay-per-call AI completion. |
| [`POST /api/ask`](#post-apiask) | none (rate-limited) | Streamed Q&A about Access0x1, grounded in repo facts. |
| [`POST /api/agent/pay`](#post-apiagentpay) | internal secret | Autonomous agent pays one or many x402 endpoints. |
| [`POST /api/ap2/mandate`](#post-apiap2mandate) | optional internal secret | Derive an AP2 mandate chain from a SessionGrant view. |
| [`GET /api/quote`](#get-apiquote) | none | USD→token quote via `router.quote()`. |
| [`GET /api/branding/{slug}`](#get-apibrandingslug) | none (public) | Public branding by checkout slug — never includes a payout address. |
| [`GET /api/branding/by-merchant/{id}`](#get-apibrandingby-merchantid) | none (public) | Public branding by on-chain merchant id. |
| [`GET /api/branding`](#get-apibranding-post-apibranding) | Dynamic JWT (read), `tenantId` query | Tenant's own branding row (verification fields gated). |
| [`POST /api/branding`](#get-apibranding-post-apibranding) | Dynamic JWT | Save branding + get a checkout slug. |
| [`GET /api/branding/check-slug`](#get-apibrandingcheck-slug) | none | Live slug availability + suggestions. |
| [`POST /api/branding/logo`](#post-apibrandinglogo) | Dynamic JWT | Sanitize a logo into an inline SVG. |
| [`POST /api/branding/checkout-mode`](#post-apibrandingcheckout-mode) | Dynamic JWT | Save the "who can pay you?" choice. |
| [`POST /api/branding/operator-verify`](#post-apibrandingoperator-verify) | Dynamic JWT + World ID | Record the operator's World ID badge. |
| [`GET /api/verify`](#get-apiverify-post-apiverify) · [`POST /api/verify`](#get-apiverify-post-apiverify) | none | Read a trust profile / verify one method (World ID, ENS, Dynamic, OIDC, on-chain). |
| [`POST /api/oidc/verify`](#post-apioidcverify) · [`GET`](#post-apioidcverify) | none | Verify an OIDC ID token and record the `oidc` method. |
| [`POST /api/world/verify`](#post-apiworldverify) | none | Verify an IDKit proof + one-human-per-action. |
| [`GET /api/world/sign`](#get-apiworldsign) | none | Mint the RP context the IDKit widget needs. |
| [`POST /api/ens/subname`](#post-apienssubname) | none | Issue a gasless ENS subname for a merchant. |
| [`GET /api/gateway/balance`](#get-apigatewaybalance) | none | Seller's Gateway + wallet USDC balance. |
| [`POST /api/gateway/withdraw`](#post-apigatewaywithdraw) | Dynamic JWT (= seller) | Withdraw accrued USDC from the Gateway balance. |
| [`POST /api/payout`](#post-apipayout) | none | Private payout leg (shield + withdraw to a fresh EOA). |
| [`POST /api/payout-swap`](#post-apipayout-swap) | internal secret | Off-CEI "receive in any coin" same-chain swap. |
| [`POST /api/onramp/session`](#post-apionrampsession-post-apiofframpsession) | none | Build a hosted fiat on-ramp checkout URL. |
| [`POST /api/offramp/session`](#post-apionrampsession-post-apiofframpsession) | none | Build a hosted fiat off-ramp ("cash out") URL. |
| [`GET /api/premium/quote`](#priced-example-endpoints) · [`GET /api/premium/dataset`](#priced-example-endpoints) · [`POST /api/premium/compute`](#priced-example-endpoints) | x402 | Priced example endpoints proving the x402 settle path (payer signs off-chain, Circle submits the tx). |

---

### `POST /api/ai/chat`

Source: [`web/app/api/ai/chat/route.ts`](../web/app/api/ai/chat/route.ts) · gateway:
[`web/lib/ai/aiGateway.ts`](../web/lib/ai/aiGateway.ts). Full guide:
[CONNECT-AI-API.md](./CONNECT-AI-API.md).

A metered AI completion. The request passes through three gates **before** the model
runs: `ak_…` key auth → `SessionGrant` budget reservation → x402 settle. The model
runs **only** after Circle settles the per-call payment (`$0.001`).

**Auth:** `Authorization: Bearer ak_…` **and** the [x402 payment](#the-x402-payment-challenge) flow.

**Request body**

```json
{ "prompt": "string (required, 1–4000 chars)" }
```

**Responses**

| Status | Body | When |
|--------|------|------|
| `200` | `{ "model": "<model>", "completion": "…", "paid": "$0.001" }` | Settled + model ran. |
| `400` | `{ "error": "BadRequest", "reason": "…" }` | Missing/empty/oversized prompt or invalid JSON. |
| `401` | `{ "error": "Unauthorized", "reason": "missing API key — send \`Authorization: Bearer ak_…\`" }` / `"invalid API key"` | No/invalid `ak_…` key. |
| `402` | `{ "error": "SessionBudgetExceeded", "sessionId", "remaining", "requested" }` | Over the session budget. |
| `402` | `{ "error": "SessionUnknown", "sessionId" }` | Key valid but its session was never opened in this process. |
| `402` | x402 challenge / verify / settle failure (see above). | No or failed payment. |
| `502` | `{ "error": "Upstream AI request failed.", "code": "upstream_error" }` | The model call errored. |
| `503` | `{ "error": "Upstream AI is not configured on this deployment.", "code": "not_configured", "note": "…" }` | No `CLAUDE_API_KEY` — **the x402 payment still settled**, only the AI body degrades, and it says so. |

---

### `POST /api/ask`

Source: [`web/app/api/ask/route.ts`](../web/app/api/ask/route.ts).

The booth Q&A assistant: a **streamed** plain-text answer grounded in
[`web/lib/judge/facts.ts`](../web/lib/judge/facts.ts). It is told to answer only
from those facts and to say it does not know rather than invent an address or claim.

**Auth:** none. Rate-limited per trusted-proxy IP (10/min) plus a never-negative
daily request **and** token cap.

**Request body**

```json
{ "question": "string (required, ≤ 2000 chars)" }
```

**Responses**

| Status | Body | When |
|--------|------|------|
| `200` | `text/plain; charset=utf-8` — the answer, **streamed**. `\n\n[stream interrupted]` is appended if the upstream stream breaks mid-answer. | Success. |
| `400` | `{ "error": "…", "code": "bad_request" }` | Bad JSON / missing / oversized question. |
| `429` | `{ "error": "…", "code": "rate_limited" }` / `"daily_cap"` | Per-IP window or daily budget exhausted. |
| `502` | `{ "error": "Assistant request failed.", "code": "upstream_error" }` | Upstream error. |
| `503` | `{ "error": "Assistant is not configured on this deployment.", "code": "not_configured" }` | No `CLAUDE_API_KEY`. |

> **Rate-limit keying:** the limiter keys on a trusted, proxy-set IP. Set
> `ASK_TRUST_PROXY=true` only when the app sits behind a single trusted reverse
> proxy/CDN that appends the real client IP; otherwise all callers share one bucket
> (a spoofable first `x-forwarded-for` is never trusted).

---

### `POST /api/agent/pay`

Source: [`web/app/api/agent/pay/route.ts`](../web/app/api/agent/pay/route.ts).

The autonomous agent's HTTP entry point. It signs and spends real USDC, so the
caller is gated by an internal shared secret **before any money moves**; an
env-configured URL allowlist (SSRF guard) and a per-request call cap are
defense-in-depth.

**Auth:** `x-internal-secret: <AGENT_INTERNAL_SECRET>`. **Fails closed:** with the
secret unset the route returns `503 not_configured` unless `AGENT_ALLOW_INSECURE=true`
(local dev only). A wrong/missing header → `401`.

**Request body**

```json
{
  "url": "string (required, must be in AGENT_URL_ALLOWLIST)",
  "count": 1,
  "pricePerCallUsd": 0.001,
  "private": false,
  "merchant": "0x… (required only when private=true)"
}
```

`count` is `1`–`50` (the nano-loop cap). `private:true` opts into the private rail
**when** `UNLINK_PRIVATE_PAY=true` and the Unlink config is present; otherwise it
falls back to the public path and never drops the payment.

**Responses**

| Status | Body | When |
|--------|------|------|
| `200` | `{ "ok": true, "result", "agent": "0x…" }` | Single public call. |
| `200` | `{ "ok": true, "results": [...], "agent": "0x…" }` | Nano-loop (`count > 1`). |
| `200` | `{ "ok": true, "rail": "private", "depositTx", "paymentTx", "agent" }` | Private rail handled it. |
| `400` | `{ "error": "BadRequest", "reason": "…" }` | Bad body / `url not in allowlist` / `count` too high. |
| `401` | `{ "error": "Unauthorized" }` | Missing/wrong internal secret. |
| `402` | `{ "error": "BudgetExceeded", "spent", "cap" }` | Agent meter over budget. |
| `402` | `{ "error": "HumanGateRequired" }` | `AGENT_REQUIRE_HUMAN` on and the agent is not backed by a verified human. |
| `502` | `{ "error": "PaymentRequiredUnresolved" }` | The upstream 402 could not be resolved. |
| `502` | `{ "error": "PrivatePayFailed", "code", "recoverable" }` | Shield landed but the payout leg failed — funds parked, recoverable (LAW #5). |
| `503` | `{ "error": "Agent pay is not configured on this deployment.", "code": "not_configured" }` | Secret unset, escape hatch off. |

---

### `POST /api/ap2/mandate`

Source: [`web/app/api/ap2/mandate/route.ts`](../web/app/api/ap2/mandate/route.ts).

The AP2 / A2A interop surface. **Pure derivation** — it moves no money and signs
nothing. Given a `SessionGrant` view (and optional cart / payment params), it
returns the AP2 mandate chain (Intent ← Cart ← Payment) so an AP2-aware
counterparty can verify the agent acted within a bounded, revocable mandate.

**Auth:** optional `x-internal-secret: <AP2_MANDATE_SECRET>`. When the secret is
**unset** the endpoint stays open (it moves no money); when set, a mismatch → `401`.

**Request body**

```json
{
  "grant": {
    "sessionId": "0x… (hex)", "owner": "0x…", "delegate": "0x…", "token": "0x…",
    "budgetCap": "1000000", "spent": "0", "expiry": 1700000000,
    "nonce": 0, "chainId": 5042002, "revoked": false
  },
  "cart": { "...optional" },
  "payment": { "...optional" },
  "options": { "...optional issuer/time overrides" }
}
```

**Responses**

| Status | Body | When |
|--------|------|------|
| `200` | `{ "ok": true, "mandates": { "intent" }, "note", "onChainTruth" }` | Intent only. |
| `200` | `{ "ok": true, "mandates": { "intent", "cart" }, … }` | Intent + cart. |
| `200` | `{ "ok": true, "mandates": { "intent", "cart", "payment" }, "linksValid": true, … }` | Full chain. |
| `400` | `{ "error": "BadRequest", "reason": "…" }` | Bad body or a builder invariant (sum / budget) failure. |
| `401` | `{ "error": "Unauthorized" }` | `AP2_MANDATE_SECRET` set, header missing/wrong. |

> Every success carries a prominent **`onChainTruth`** caveat: the mandate is
> *derived*, not authoritative. The proof stub is **unsigned**; a consumer MUST
> re-verify the SessionGrant on-chain before relying on it (LAW #4).

---

### `GET /api/quote`

Source: [`web/app/api/quote/route.ts`](../web/app/api/quote/route.ts).

Calls `router.quote()` via a server-side public client (no wallet, no RPC key in the
browser) to convert a USD price into a token amount. On a contract revert the revert
**name** is surfaced so the checkout shows an honest error and disables pay —
never a silent wrong price (LAW #4).

**Query params:** `chainId` (positive int), `merchantId` (non-negative int),
`token` (`0x…`), `usdAmount8` (positive int, 8-decimal USD).

**Responses**

| Status | Body | When |
|--------|------|------|
| `200` | `{ "tokenAmount": "<string>" }` | Quote succeeded. |
| `200` | `{ "error": "<RevertName>" }` | A contract revert (e.g. `OracleLib__StalePrice`). Returned `200` with an `error` so the UI can read the reason and disable pay. |
| `400` | `{ "error": "Missing required query params…" }` / `"Invalid numeric query param"` / sign checks | Bad input. |
| `500` | `{ "error": "<router address not configured>" }` | Router env not set — surfaced loudly, never a silent `200`. |

---

### `GET /api/branding/{slug}`

Source: [`web/app/api/branding/[slug]/route.ts`](../web/app/api/branding/[slug]/route.ts).

The **public, read-only** branding the one-tag embed fetches by checkout slug.
Permissive CORS so the cross-origin embed can read it. **Never** returns a payout
address; **only** `GET`/`OPTIONS`.

**Responses**

| Status | Body | When |
|--------|------|------|
| `200` | the [public branding payload](#the-public-branding-payload) | Slug found. |
| `404` | `{ "error": "not_found" }` | Unknown slug (the embed degrades to a USD-only label). |
| `204` | _(empty)_ | `OPTIONS` CORS preflight. |

---

### `GET /api/branding/by-merchant/{id}`

Source: [`web/app/api/branding/by-merchant/[id]/route.ts`](../web/app/api/branding/by-merchant/[id]/route.ts).

The same public payload, looked up by **on-chain merchant id** (used by the
MetaMask Snap's `onTransaction`, whose fetch carries `Origin: null`).

**Responses**

| Status | Body | When |
|--------|------|------|
| `200` | the [public branding payload](#the-public-branding-payload) | Found. |
| `400` | `{ "error": "invalid_merchant_id" }` | `id` is not a non-negative integer. |
| `404` | `{ "error": "not_found" }` | No tenant with that merchant id. |
| `204` | _(empty)_ | `OPTIONS` preflight. |

#### The public branding payload

Shared by both public read routes
([`web/lib/branding/response.ts`](../web/lib/branding/response.ts)). It **never**
includes a payout address, fee config, or owner.

```json
{
  "name": "string", "description": "string", "logoSvg": "<inline svg>",
  "brandColor": "#RRGGBB", "merchantId": "string|null", "router": "0x…|null",
  "chainId": 0, "onChain": false, "checkoutMode": "standard|verified-human|private",
  "humanVerifier": "offchain|onchain", "requiredTier": "standard|…",
  "vertical": "…", "verifiedOperator": false
}
```

> CORS: `Access-Control-Allow-Origin: *`, methods `GET, OPTIONS`,
> `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600`.

---

### `GET /api/branding` · `POST /api/branding`

Source: [`web/app/api/branding/route.ts`](../web/app/api/branding/route.ts).

The tenant-scoped read/write for the dashboard's Branding settings.

**`GET`** — reads the calling tenant's own row to prefill the editor.
- **Query:** `?tenantId=0x…` (unauthenticated).
- **Auth (optional):** `Authorization: Bearer <dynamic-jwt>` for the *same* tenant.
- A verified owner gets the **full** row; everyone else gets the row with the
  verification fields (`operatorNullifier`, `humanVerifier`, `requiredTier`)
  **stripped** (R-8 — no personhood/enumeration leak).
- Returns `{ "branding": <row|null> }`; `{ "branding": null }` when nothing saved.
  A junk `tenantId` → `401 { "error": "unauthorized" }`.

**`POST`** — "Save and get my checkout link". Resolves the tenant from sign-in,
sanitizes name/description/color, auto-derives a unique slug, and auto-generates a
monogram logo when none was uploaded.
- **Auth:** `Authorization: Bearer <dynamic-jwt>` (falls back to a shape-checked
  body `tenantId` only when no issuer is configured).
- **Body:** `{ tenantId, displayName, description?, brandColor?, checkoutSlug?, logoSvgInline? }`.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "branding": <row> }` | Saved. |
| `400` | `{ "error": "invalid_json" }` / `{ "error": "…", "code": "…" }` | Bad JSON / shape error. |
| `401` | `{ "error": "…" }` | No valid tenant. |
| `409` | `{ "error": "…", "code": "SLUG_TAKEN" }` | Checkout slug collision. |
| `500` | `{ "error": "save_failed" }` | Unexpected store error. |

---

### `GET /api/branding/check-slug`

Source: [`web/app/api/branding/check-slug/route.ts`](../web/app/api/branding/check-slug/route.ts).

Powers the live green-check / red-X under "What is your business called?".
**Query:** `?slug=<raw>&tenantId=0x…` (the tenant's own current slug counts as
available). Read-only.

```json
{ "valid": true, "available": true, "normalized": "joes-barbershop", "suggestions": [] }
```

---

### `POST /api/branding/logo`

Source: [`web/app/api/branding/logo/route.ts`](../web/app/api/branding/logo/route.ts).

Accepts `{ tenantId, logo }` where `logo` is raw SVG markup **or** a base64
`data:image/<png|jpeg|webp|gif>;base64,…` raster, **sanitizes** it (strips every
script / event handler / remote ref) and returns an inert inline SVG.

**Auth:** Dynamic JWT.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "logoSvgInline": "<svg>", "kind": "…" }` | Sanitized OK. |
| `400` | `{ "error": "Add a logo image or SVG." }` / `{ "error": "<LogoError message>" }` | Missing / scriptful / unsupported. |
| `401` | `{ "error": "…" }` | No valid tenant. |
| `413` | `{ "error": "That logo is too large." }` | Over the size cap. |

---

### `POST /api/branding/checkout-mode`

Source: [`web/app/api/branding/checkout-mode/route.ts`](../web/app/api/branding/checkout-mode/route.ts).

Saves the "who can pay you?" choice (`verified-human` | `private` | `standard`) on
the existing branding row.

**Auth:** Dynamic JWT. **Body:**
`{ tenantId, checkoutMode, humanVerifier?, requiredTier?, vertical? }`.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "branding": <row> }` | Saved. |
| `400` | `{ "error": "no_branding" }` | No row yet — set name/logo first. |
| `400` | `{ "error": "…", "code": "…" }` | e.g. `CASINO_NEEDS_OPERATOR` (a casino must verify its operator first). |
| `401` | `{ "error": "…" }` | No valid tenant. |

---

### `POST /api/branding/operator-verify`

Source: [`web/app/api/branding/operator-verify/route.ts`](../web/app/api/branding/operator-verify/route.ts).

The operator proves they are a real, unique human with World ID; on success it sets
`verifiedOperator=true` on the row (load-bearing for the casino vertical). Scoped to
a distinct operator action so the slot never collides with the buyer or agent gates.

**Auth:** Dynamic JWT + a raw IDKit proof in the body.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "branding": <row> }` | Verified — operator badge recorded. |
| `400` | `{ "error": "invalid_json" \| "bad_nullifier" \| "no_branding" }` | Bad input / no row. |
| `401` | `{ "error": "…" }` / `{ "error": "proof_invalid", "code" }` | No tenant / portal rejected the proof. |
| `409` | `{ "error": "already_verified" }` | This human already verified an operator. |
| `502` | `{ "error": "verify_unreachable" }` | Portal/network unreachable. |
| `503` | `{ "error": "not_configured" }` | World ID env unset (pre-booth). |

---

### `GET /api/verify` · `POST /api/verify`

Source: [`web/app/api/verify/route.ts`](../web/app/api/verify/route.ts).

The Super Verification API. Every method is **really** checked (LAW #4) — the route
never just trusts a `method` string. It is verify-only: it never signs, holds, or
moves money.

**`GET`** — `?user=0x…` → the profile + derived fields:

```json
{ "user": "0x…", "methods": ["…"], "score": 0, "tier": "standard", "nextStep": "…" }
```

A junk `user` → `400 { "error": "bad_user" }`.

**`POST`** — verify one method and record it. **Body:** `{ user, method, …method-specific }`.

| `method` | Extra body / source of truth | Notes |
|----------|------------------------------|-------|
| `world-id` | raw IDKit proof (nested `proof` or top-level fields) | Verified with the Developer Portal; nullifier claimed (one human/action). |
| `ens` | `ensName` | Must **forward-resolve** to the user's wallet. |
| `dynamic` | `Authorization: Bearer <dynamic-jwt>` | Verified wallet must match `user`. |
| `oidc` | `token` / `id_token` | Verified server-side; one issuer+subject verifies once. |
| `onchain` | _(none)_ | Reads the wallet on-chain — funded (balance > 0) or active (nonce > 0). |

| Status | Body | When |
|--------|------|------|
| `200` | the profile (same shape as `GET`) | Method verified + recorded. |
| `400` | `{ "error": "invalid_json" \| "bad_user" \| "bad_method" \| "missing_proof" \| "missing_ens_name" \| … }` | Bad input. |
| `401` | `{ "error": "<code>", "method" }` | Real check failed (e.g. `proof_invalid`, `ens_mismatch`, `dynamic_mismatch`, `wallet_empty`). |
| `409` | `{ "error": "already_verified", "method" }` | Identity already used (nullifier / OIDC subject). |
| `502` | `{ "error": "<code>", "method" }` | Upstream unreachable (`verify_unreachable`, `ens_unreachable`, …). |
| `503` | `{ "error": "not_configured", "method" }` | The check's upstream is booth-gated. |

---

### `POST /api/oidc/verify`

Source: [`web/app/api/oidc/verify/route.ts`](../web/app/api/oidc/verify/route.ts).

Verifies a "Sign in with Google" / OIDC ID token **server-side** (signature + iss +
aud + exp) and records the `oidc` method into the user's trust profile. Generic: no
vendor name appears in the code. "Verify for all" — if the token carries an agent
claim, the verified agent id is recorded too.

**Body:** `{ user: "0x…", token | id_token: "<jwt>", agent?: "0x…" }`.

| Status | Body | When |
|--------|------|------|
| `200` | profile + `{ "oidc": { subject, email, agent }, "agentProfile": … }` | Verified + recorded. |
| `400` | `{ "error": "invalid_json" \| "bad_user" \| "missing_token", "method": "oidc" }` | Bad input. |
| `401` | `{ "error": "token_invalid", "method": "oidc" }` | Bad signature / iss / aud / exp. |
| `409` | `{ "error": "already_verified", "method": "oidc" }` | This OIDC account already verified. |
| `502` | `{ "error": "jwks_unreachable", "method": "oidc" }` | Provider keys unreachable. |
| `503` | `{ "error": "not_configured", "method": "oidc" }` | No audience/client id configured. |

**`GET`** — `?user=0x…` returns the read-only profile (mirrors `GET /api/verify`).

---

### `POST /api/world/verify`

Source: [`web/app/api/world/verify/route.ts`](../web/app/api/world/verify/route.ts).

Verifies a raw IDKit proof with the World ID Developer Portal and enforces
one-human-per-action. The body may **select** a gate (`{ "gate": "buyer" | "agent" }`,
default `buyer`) — an enum, never the action string itself, so a body cannot widen
its own scope. Every other proof field is forwarded byte-for-byte. Verify/gate-only:
it never moves money.

**Body:** the raw IDKit result, optionally `{ "gate": "agent" }`.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "ok": true, "action": "<server-action>" }` | Verified + first use → unlock pay. |
| `400` | `{ "error": "invalid_json" \| "bad_nullifier" }` | Bad input. |
| `401` | `{ "error": "proof_invalid", "code" }` | Portal rejected the proof. |
| `409` | `{ "error": "already_verified" }` | This human already cleared this action. |
| `502` | `{ "error": "verify_unreachable" }` | Portal/network unreachable. |
| `503` | `{ "error": "not_configured" }` | World ID env unset. |

---

### `GET /api/world/sign`

Source: [`web/app/api/world/sign/route.ts`](../web/app/api/world/sign/route.ts).

Mints the relying-party (RP) context the IDKit widget needs for World ID 4.0. Reads
the **server-only** signing key and returns only the public RP context — never the
key. The response is `Cache-Control: no-store` (each context is single-use, ~5-min TTL).

| Status | Body | When |
|--------|------|------|
| `200` | `{ "rp_id", "nonce", "created_at", "expires_at", "signature" }` | Signed. |
| `500` | `{ "error": "sign_failed" }` | Signing threw (no key/stack ever leaked). |
| `503` | `{ "error": "not_configured" }` | RP id / signing key env unset. |

---

### `POST /api/ens/subname`

Source: [`web/app/api/ens/subname/route.ts`](../web/app/api/ens/subname/route.ts).

Issues a gasless ENS subname `<label>.<PARENT>.eth` for a merchant via Namestone,
writing display/config into ENS TEXT records. Reads the parent + API key server-side
from env — never hardcoded, never echoed. Writes **only** display/config records: no
money, no key, no payout address ever passes through.

**Body (either shape):**
```json
{ "label": "merchant-42", "owner": "0x…", "texts": [{ "key": "…", "value": "…" }] }
```
or the onboarding shape `{ "merchantId": "42", "owner": "0x…", "router?": "0x…", "chainId?": 84532 }`.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "name", "label", "parent", "owner" }` | Issued. |
| `400` | `{ "error": "invalid_json" \| "bad_input" }` | Missing/invalid label or owner. |
| `502` | `{ "error": "namestone_error", "detail?" }` | Upstream Namestone error. |
| `503` | `{ "error": "not_configured" }` | Seam off (no key / no parent) — did nothing. |

---

### `GET /api/gateway/balance`

Source: [`web/app/api/gateway/balance/route.ts`](../web/app/api/gateway/balance/route.ts).

Reads the seller's Gateway available balance + wallet USDC, both normalized to
6-decimal USDC strings. A balance read is **informational** — any upstream error
returns zero, never a `500` that breaks the dashboard (LAW #5).

| Status | Body | When |
|--------|------|------|
| `200` | `{ "gateway": "5.000000", "wallet": "1.250000" }` | Read OK (or `"0.000000"` on any upstream error). |
| `503` | `{ "ok": false, "reason": "not_configured", "error": "SELLER_ADDRESS is not set." }` | Seller env unset — honest-dormant state, not a server fault. |

---

### `POST /api/gateway/withdraw`

Source: [`web/app/api/gateway/withdraw/route.ts`](../web/app/api/gateway/withdraw/route.ts).

Withdraws accrued USDC from the seller's Gateway balance. The caller must be the
seller: a Dynamic JWT is verified and the wallet must equal `SELLER_ADDRESS`. A
balance pre-check runs **before** any signed tx (off-CEI); a gas error is translated
to a friendly message, never swallowed (LAW #5).

**Auth:** `Authorization: Bearer <dynamic-jwt>` (= seller). **Body:**
`{ amount: "<decimal string>", destinationChain: "<chain key>", recipient: "0x…" }`.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "mintTxHash": "0x…" }` | Withdrawal submitted. |
| `400` | `{ "error": "invalid amount" \| "unsupported chain" \| "invalid recipient" \| "insufficient balance" }` | Validation / balance / gas-shortfall. |
| `401` | `{ "error": "…" }` | Missing/invalid Dynamic JWT. |
| `403` | `{ "error": "forbidden: caller wallet does not match the seller address" }` | Authed, but not the seller. |
| `500` | `{ "error": "SELLER_ADDRESS is not configured on this server." }` | Seller env unset. |
| `502` | `{ "error": "<friendly message>" }` | Upstream gateway/client error. |

---

### `POST /api/payout`

Source: [`web/app/api/payout/route.ts`](../web/app/api/payout/route.ts).

The private payout leg: register the user, then shield a larger amount into the
private set and withdraw a smaller amount to a **fresh** EOA. Runs **after**
settlement is final — entirely off the Solidity money path; it never calls the
router. No Unlink API key ever reaches a response.

**Body:** `{ amountUsd, depositAmountUsd, destination: "0x…", userId }` —
`depositAmountUsd` **must exceed** `amountUsd` (the asymmetry keystone).

| Status | Body | When |
|--------|------|------|
| `200` | `{ "depositTx": "0x…", "withdrawTx": "0x…" }` | Shield + withdraw succeeded. |
| `400` | `{ "error": "<field message>" }` | Validation (amounts, address, ordering, userId). |
| `500` | `{ "error": "registration_failed" \| "unexpected_error" }` | Unexpected failure. |
| `502` | `{ "code": "shield_failed" }` | No funds shielded — safe to retry. |
| `502` | `{ "code": "withdraw_failed", "recoverable": true }` | Shield landed; funds parked in the private balance, recoverable (LAW #5). |
| `503` | `{ "code": "unlink_sdk_unavailable", "recoverable": true }` | Unlink SDK absent (pre-booth) — nothing moved. |

---

### `POST /api/payout-swap`

Source: [`web/app/api/payout-swap/route.ts`](../web/app/api/payout-swap/route.ts).

The off-CEI "receive in any coin" leg: after settlement pushes net USDC to the
merchant, this swaps it into the merchant's configured payout token on the **same
chain** (the swap is always merchant-signed / non-custodial). Purely additive — a
failed, skipped, or unconfigured swap returns `swapped:false` and the merchant
simply keeps the USDC; it never calls the router or blocks settlement.

**Auth:** `x-internal-secret: <PAYOUT_SWAP_INTERNAL_SECRET>` (server-to-server).
**Fails closed:** with the secret unset → `503 not_configured` unless
`PAYOUT_SWAP_ALLOW_INSECURE=true` (local dev only).

**Body:** `{ chainId, usdc: "0x…", payoutToken: "0x…", merchant: "0x…", amountUsdc: "<base-unit string>", minAmountOut: "<base-unit string>" }`.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "swapped": true, "amountOut": "<string>", … }` | Swap executed. |
| `200` | `{ "swapped": false, "reason": "chain-not-capable", "detail": "…" }` | No same-chain rail, or the rail is unconfigured — the merchant keeps USDC. |
| `400` | `{ "error": "…" }` | Invalid `chainId` / address / amount string. |
| `401` | `{ "error": "unauthorized" }` | Secret set, header missing/wrong. |
| `503` | `{ "error": "Payout-swap is not configured on this deployment.", "code": "not_configured" }` | Secret unset, escape hatch off. |

---

### `POST /api/onramp/session` · `POST /api/offramp/session`

Source: [`web/app/api/onramp/session/route.ts`](../web/app/api/onramp/session/route.ts) ·
[`web/app/api/offramp/session/route.ts`](../web/app/api/offramp/session/route.ts).

Build a hosted fiat **on-ramp** ("bring money from a bank") or **off-ramp** ("cash
out") checkout URL for whichever provider env selects (none hardcoded). The provider
gets only a **safe** (`https:`-validated) return URL; a `javascript:`/`data:`/`http:`
redirect is dropped. Neither route touches the Solidity money path; no secret
reaches the response.

**Body:** `{ address: "0x…" (required), amount?, asset?, network?, redirectUrl? }`.
For on-ramp `address` is the destination wallet; for off-ramp it is the source wallet.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "provider", "url", "partnerFeePercent" }` | Session built. |
| `400` | `{ "error": "invalid_json" \| "address must be a valid 0x address" }` / `{ "error": "<code>", "reason" }` | Bad input. |
| `503` | `{ "error": "not_configured", "reason" }` | Ramp provider env unset — built nothing. |

---

### Priced example endpoints

Source: [`web/app/api/premium/quote/route.ts`](../web/app/api/premium/quote/route.ts) ·
[`dataset`](../web/app/api/premium/dataset/route.ts) ·
[`compute`](../web/app/api/premium/compute/route.ts).

Three endpoints behind the [x402 challenge](#the-x402-payment-challenge), proving the
x402 settle path end-to-end — the payer signs off-chain and Circle submits the
transaction. Each is served **only** if Circle settles.

| Endpoint | Price | `200` body |
|----------|-------|-----------|
| `GET /api/premium/quote` | `$0.001` | `{ "quote", "category", "timestamp" }` |
| `GET /api/premium/dataset` | `$0.01` | `{ "dataset": [{ id, symbol, score }], "generated_at" }` |
| `POST /api/premium/compute` | `$0.03` | `{ "input", "result", "computed_at" }` (body `{ "input": "string" }` is read **after** settle) |

Without a valid `payment-signature` each returns the `402` challenge.

---

## See also

- [CONNECT-AI-API.md](./CONNECT-AI-API.md) — the full guide to the metered AI key flow (`/api/ai/chat`).
- [GETTING-STARTED.md](./GETTING-STARTED.md) — zero-to-payment, including the React `<PayButton>` and the local stack.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the on-chain money spine the web routes sit in front of actually works.
- [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) — the source of truth for live addresses and chain ids.
- [START-HERE.md](./START-HERE.md) — the full doc map.
