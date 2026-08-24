# Optional seams — how to switch each one on

Access0x1's core checkout (register a merchant → take a USD-priced, zero-custody
payment) needs **no** third-party credential — see
[INTEGRATION-CHECKLIST.md](./INTEGRATION-CHECKLIST.md). Everything on this page is an
**optional seam**: real, in-repo, and **env-gated + fail-soft** — blank config is a
clean no-op, never a blocked payment (law: money paths degrade, never break).

Each seam is **already wired and tested**; the only thing that turns it on is a value
you provide. This page is the activation map — one row per seam: *what it does · what
you set · where the value comes from · how to confirm it's live · what "off" does.*

> **Secrets stay out of the repo.** `.env.example` holds NAMES only. Put real values
> in `.env` (gitignored) or your deploy secrets — never in a commit
> ([SECURITY.md](../SECURITY.md)). `NEXT_PUBLIC_*` vars are inlined into
> the browser bundle and are **not secret** (public ids/urls only); everything else is
> server-only.

> **Scope: testnet.** "Live" below means live on a testnet. No mainnet
> ([FAQ → mainnet](./FAQ.md#can-i-run-this-on-mainnet)).

---

## At a glance

| Seam | Turns on | Set (server unless `NEXT_PUBLIC_`) | Get it from |
| --- | --- | --- | --- |
| **Circle x402** | USDC micro-payments settled via x402 | `SELLER_ADDRESS` (+ `NEXT_PUBLIC_X402_*` off-Arc) | your payout EOA (a decision, not a signup) |
| **World ID** | proof-of-human gate before pay | `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_SIGNING_KEY` | developer.worldcoin.org |
| **OIDC** (Sign in with Google) | ID-token verification method | `NEXT_PUBLIC_OIDC_CLIENT_ID` (+ optional `OIDC_*`) | Google Cloud → OAuth client |
| **Unlink** | confidential merchant payouts | `UNLINK_API_KEY` + `UNLINK_PRIVATE_PAY=true` (or `NEXT_PUBLIC_EARNINGS_PRIVACY=true`) + `NEXT_PUBLIC_UNLINK_USDC_<chainId>` | dashboard.unlink.xyz |
| **ENS subnames** | gasless `merchant-x.you.eth` | `NAMESTONE_API_KEY`, `ENS_SUBNAME_PARENT` | namestone.com |
| **Uniswap swap** | receive-in-any-coin payout | `UNISWAP_TRADING_API_URL` (+ `UNISWAP_TRADING_API_KEY`) | developer.uniswap.org |
| **Blink** | one-tap buyer deposit | `BLINK_ENABLED=true`, `NEXT_PUBLIC_BLINK_APP_ID` | the deposit provider |
| **Bank on-ramp** | fiat funding on the checkout | `ONRAMP_PROVIDER`, `NEXT_PUBLIC_ONRAMP_*`, `ONRAMP_SERVER_KEY` | Coinbase / MoonPay / Stripe |
| **Flow** | pay-in-any-token at checkout | `NEXT_PUBLIC_FLOW_ENABLED=true`, `FLOW_PROVIDER`, `FLOW_SERVER_KEY` | a swap aggregator |
| **Paymaster** | sponsored (gasless) UX off-Arc | `PAYMASTER_ENABLED=true`, `NEXT_PUBLIC_PAYMASTER_URL`, `NEXT_PUBLIC_PAYMASTER_CHAIN_ID` | any ERC-4337 bundler |
| **Walrus** (Sui) | un-takedownable checkout mirror | Sui testnet account + publish step | sui.io testnet faucet |
| **The Graph** | indexed analytics + receipt history | `NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL` | thegraph.com Studio (deploy `subgraph/`) |

**Rule of thumb:** a `*_ENABLED=true` flag alone does nothing — every gate checks the
flag **and** its credential, so a half-set seam stays safely dormant. Set both.

---

## Per-seam detail

### Circle x402 — USDC micro-payments
- **Does:** the HTTP-402 seller spine ([`web/lib/x402.ts`](../web/lib/x402.ts)) settles
  USDC micro-payments through Circle's Gateway on Arc — the payer signs off-chain and
  Circle submits the transaction.
- **Set:** `SELLER_ADDRESS` (your payout EOA — a money-routing choice, so it's yours to
  set). The Arc network/USDC/Gateway values are already booth-confirmed defaults; other
  chains read `NEXT_PUBLIC_X402_*_<chainId>`.
- **Verify:** POST to a priced route (e.g. `/api/premium/quote`) with no payment header →
  it returns `402` with a `PAYMENT-REQUIRED` challenge instead of `500`.
- **Off:** the priced routes still 402 but can't settle; the core `payToken` checkout is
  unaffected.

### World ID — proof-of-human gate
- **Does:** a one-tap personhood proof **in front of** pay
  ([`web/components/WorldIdGate.tsx`](../web/components/WorldIdGate.tsx)); off the money path.
- **Set:** `NEXT_PUBLIC_WORLD_APP_ID` + `WORLD_RP_ID` + `WORLD_SIGNING_KEY`, plus a durable
  `NULLIFIER_STORE_URL`. The action strings (`WORLD_ACTION` and the operator/agent/agentkit
  siblings) are optional overrides with working defaults.
- **Get:** create an app at **developer.world.org** → App ID, RP id, and a signing key
  (returned **once**). Register every action string you use inside that app.
- **Verify:** `GET /api/world/status`. It reports `ready` and a `label`, and names the env
  variables still blank — by NAME, never a value. `ready:true` needs all four of the above,
  because a nullifier store that forgets on restart cannot deliver one-human-per-action.
- **Off:** a verified-human merchant **degrades to standard checkout** — never a blocked pay.
- **Staging vs production:** `NEXT_PUBLIC_WORLD_ENVIRONMENT` is the **single switch**, and
  staging (the Worldcoin Simulator) is the default. It is `NEXT_PUBLIC_`, so it is inlined at
  **build** time — flipping it needs a rebuild and redeploy, plus a separately registered
  production app and a real World App user. Treat it as an owner decision, never a runtime
  env change.
- **Durability:** with no durable store, a runtime that demands one (`NODE_ENV=production`,
  or `VERIFY_REQUIRE_DURABLE_STORE=true`) **refuses to verify** — 503, never a silent
  fallback to the in-memory set. Dev keeps the in-memory store with a loud warning.
- **Honesty:** the `label` from `/api/world/status` is the wording to use. Anything short of
  fully wired is "built, env-gated", and **fully wired tops out at "configured, unverified"**.
  Neither rung is "live": that route reads env presence, which says a verify COULD complete and
  never that one did, so no value it can compute earns the word. A human upgrades the label
  after watching a real proof clear. Never a claimed ZK proof either.

### OIDC — Sign in with Google (or any provider)
- **Does:** server-side ID-token verification ([`web/lib/oidc`](../web/lib/oidc)) that
  adds an `oidc` verification method (stacks with World ID / ENS / Dynamic).
- **Set:** `NEXT_PUBLIC_OIDC_CLIENT_ID` (the audience). Defaults verify Google ID tokens;
  override `OIDC_ISSUER` / `OIDC_JWKS_URL` / `OIDC_AUDIENCE` for any other provider.
- **Get:** a Google Cloud OAuth **client id** (or your provider's).
- **Off:** blank ⇒ the OIDC method is simply absent.

### Unlink — confidential payouts
- **Does:** shields a settled-USDC payout off the public ledger
  ([`web/lib/unlink`](../web/lib/unlink)); off the money path.
- **Set:** `UNLINK_API_KEY` (server) + **one** privacy flag — `UNLINK_PRIVATE_PAY=true`
  (the agent rail) **or** `NEXT_PUBLIC_EARNINGS_PRIVACY=true` (the merchant-facing knob);
  both route the same shield+withdraw — plus the per-chain shielded token
  `NEXT_PUBLIC_UNLINK_USDC_<chainId>` (Arc falls back to `ARC_TESTNET_USDC`) and, off Arc,
  `NEXT_PUBLIC_UNLINK_CHAIN_ID`. The route also needs `UNLINK_PAYOUT_PRIVATE_KEY`.
- **Get:** **dashboard.unlink.xyz** → org → project → API Keys (shown once).
- **Verify:** `privatePayStatus()` returns **`"on"`** — not `flag_off` (a flag typo reads
  exactly like OFF) and not `not_configured` (key/token missing). Confirm the status, never
  just that the key is set.
- **Off:** degrades to a standard **public** USDC payout — funds still move, but the payout
  is visible on-chain, so a mis-set flag silently leaves earnings public.
- **The package:** `@unlink-xyz/sdk` is **not installed here**, so this seam is built and
  env-gated but **dependency-absent** — every path fails soft to the public rail. The loader
  tries the root specifier and then the documented subpaths (`/crypto`, `/admin`, `/client`,
  `/advanced`), because the package's current canary publishes **no root export** and a bare
  import would fail to resolve even with the package installed.
- **Proving it without the package:** `UNLINK_FAKE_SDK=true` (dev only, **refused** when
  `NODE_ENV=production`) runs the whole payout seam against an in-repo fake shielded set
  ([`web/lib/unlink/fakeSdk.ts`](../web/lib/unlink/fakeSdk.ts)). It settles **nothing** and
  marks every tx hash `0xfa4e…`. Use it to exercise auth, the owner binding, validation,
  registration ordering, the asymmetry keystone, and both recoverable-error surfaces. Nothing
  it produces is evidence the rail is live.

### ENS subnames — gasless `merchant-x.you.eth`
- **Does:** issues offchain merchant subnames via Namestone
  ([`web/lib/ens-subnames.ts`](../web/lib/ens-subnames.ts)). (ENS *resolution* + verified
  identity are always on and need no key — this is only the subname **write**.)
- **Set:** `NAMESTONE_API_KEY` + `ENS_SUBNAME_PARENT` (+ optional `NAMESTONE_BASE_URL`).
- **Get:** **namestone.com** API key; the parent is an ENS name you control.
- **Off:** subname issuance returns a clean `{ok:false}` no-op; resolution still works.
- **Quirk:** the key goes in the `Authorization` header with **no** `Bearer` prefix.

### Uniswap — receive-in-any-coin payout swap
- **Does:** the post-settlement "receive in any coin" swap rail
  ([`web/lib/payout-swap`](../web/lib/payout-swap)); off-CEI, never in the router.
- **Set:** `UNISWAP_TRADING_API_URL` (+ `UNISWAP_TRADING_API_KEY`). The zkSync classic
  leg additionally needs `ZKSYNC_SEPOLIA_RPC_URL` (and optionally `BLINK_RPC_URL`).
- **Get:** **developer.uniswap.org** → Trading API base URL + `x-api-key`.
- **Off:** `selectPayoutSwapClient` reports the chain has no rail → the route returns
  `swapped:false` and the merchant keeps the settled USDC.

### Blink — one-tap buyer deposit
- **Set:** `BLINK_ENABLED=true` + `NEXT_PUBLIC_BLINK_APP_ID` (+ optional token/chain).
- **Off:** the one-tap deposit button is hidden.

### Bank on-ramp — fiat funding
- **Set:** `ONRAMP_PROVIDER` (coinbase | moonpay | stripe | circle | blink) +
  `NEXT_PUBLIC_ONRAMP_BASE_URL` + `NEXT_PUBLIC_ONRAMP_APP_ID` + `ONRAMP_SERVER_KEY`.
- **Off:** the bank-funding option is hidden.

### Flow — pay-in-any-token at checkout
- **Set:** `NEXT_PUBLIC_FLOW_ENABLED=true` + `FLOW_PROVIDER` (lifi | uniswap | oneinch |
  paraswap | 0x) + `NEXT_PUBLIC_FLOW_APP_ID` + `FLOW_SERVER_KEY`.
- **Off:** the checkout settles in the picked token / USDC exactly as today (the swap step
  is a documented adapter until a provider is set — the copy never claims a token was
  swapped when it wasn't).

### Paymaster — sponsored gas (off-Arc)
- **Does:** ERC-7677 sponsored gas ([`web/lib/paymaster`](../web/lib/paymaster)). On Arc
  this is unnecessary (USDC is the gas token).
- **Set:** `PAYMASTER_ENABLED=true` + `NEXT_PUBLIC_PAYMASTER_URL` +
  `NEXT_PUBLIC_PAYMASTER_CHAIN_ID` (the "gas sponsored" badge shows only on that chain).
- **Off:** buyers pay their own gas on non-Arc chains.

### Walrus (Sui) — un-takedownable checkout mirror
- **Does:** publishes the checkout page + receipts to Walrus content-addressed storage.
- **Set:** a Sui testnet account + run the publish step (see the Sui prep docs).
- **Off:** the app serves normally from its origin.

---

### The Graph — indexed analytics + receipt history

Deploy [`subgraph/`](../subgraph) to Studio and set `NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL` to the query
endpoint. Blank ⇒ both readers ([`web/lib/graph-analytics.ts`](../web/lib/graph-analytics.ts),
[`web/lib/dashboard-receipts.ts`](../web/lib/dashboard-receipts.ts)) report dormant and the UI falls
back to a bounded per-contract `getLogs` window.

One read has **no fallback**: the cross-entity top-N merchant leaderboard is precisely the query a
bounded log window cannot answer, so it exists only with the index on. `_meta.block.number` and
`hasIndexingErrors` come back with every query, so a UI labels data "as of block N" rather than
trusting a lagging indexer.

`codegen` and `build` inside `subgraph/` validate the manifest and mappings offline — no Studio
account is needed to check a change.

## Not env-activatable (by design)

- **Circle App Kit swap** ([`web/lib/payout-swap/rails/circleAppKit.ts`](../web/lib/payout-swap/rails/circleAppKit.ts))
  is a stub behind an injectable SDK seam. It is **intentionally** not wired from server
  env: App Kit is a **browser** SDK that runs on the merchant's own wallet (non-custodial),
  so it belongs in a client flow, not the server-side payout-swap worker. Activating it is
  an SDK-install + client-wiring task, not a config value.
- **Yellow** is out of scope for this build and is not wired. (**The Graph** was listed on this line
  historically and that was wrong: the subgraph and both of its readers are built and env-gated — see
  the section above.)

## Where each gate lives (source of truth)

The `isXConfigured()` gate for every seam is a small pure function you can read:
`web/lib/{worldid,x402,onramp,flow,paymaster,oidc}/config.ts`,
`web/lib/unlink/privatePayConfig.ts`, `web/lib/funding/blink.ts`, and
`web/lib/ens-subnames.ts`. The full env catalogue with inline notes is
[`.env.example`](../.env.example); what each partner provided is in the README
[Partners & Integrations](../README.md#partners--integrations) section.
