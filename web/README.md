# Access0x1 web app

The hosted Next.js 15 app that turns the Access0x1 contracts into a product non-contract
developers can run, deploy, and embed — **without writing a line of Solidity**. It is
zero-custody end to end: every payment is one on-chain transaction (buyer → router → merchant +
treasury in the same block); this app never holds keys or funds.

> Working on the contracts or the React SDK instead? See the [repo README](../README.md) and
> [`packages/react`](../packages/react/README.md). This document covers **only** the `web/` app.

## What it does

| Surface | Route | Role |
|---|---|---|
| **Merchant onboarding** | `/onboard` | A business connects a wallet (Dynamic), picks a slug, and gets a branded checkout link — no keystore, no Solidity. |
| **Hosted checkout** | `/c/<slug>`, `/m/<merchantId>` | The buyer-facing pay page: a live USD→crypto quote (one `eth_call` to the router's `quote` view) and a one-transaction pay. |
| **Dashboard** | `/dashboard` | The merchant's payment log + settings (`/settings/branding`, `/settings/checkout`). |
| **One-Tag Checkout embed** | [`public/embed.js`](public/embed.js) | A single `<script>` tag any merchant pastes into any HTML page to get a "Pay with Crypto" button (no build step, no npm). See [Embed integration](#embed-integration). |

The app also exposes the server-side seams documented in [`.env.example`](.env.example): the x402
nanopayment seller routes, the Dynamic AI payment agent, ENS merchant identity (read + gasless
subname), World ID / OIDC verification, and the funding/on-ramp + payout-swap rails. Each seam is
**env-gated and fails soft** — a blank variable means that path is a clean no-op, never an error and
never a fabricated value (LAW #4: truth in copy).

## Run locally

Requires Node 20+ and npm. From the repo root you can use the make targets; from `web/` use npm
directly — both run the same scripts.

```sh
# from the repo root
make web-install       # cd web && npm install
make web-dev           # next dev → http://localhost:3000

# or from web/
npm install
npm run dev            # http://localhost:3000
```

The app starts **with no environment configured** — every contract-address and feature variable is
optional. With nothing set, the checkout renders the USD price and the embed button degrades to its
USD-only label (the quote `eth_call` is skipped); point it at a deployed router via `.env.local`
(below) to see live crypto quotes and real payments.

```sh
cp .env.example .env.local   # NAMES only ship in the repo — fill values in .env.local (gitignored)
```

> `.env.example` is the canonical, commented reference for **every** variable, what it controls, and
> its fail-soft behavior when blank. This repo is public: it ships variable **names only** — never a
> value, never a secret. Never commit a real key.

### Gate (run before every commit)

```sh
make web-gate          # cd web && npm run gate
# = node --check public/embed.js   (embed syntax)
#   node scripts/verify-embed.js   (embed behavior: calldata, quote, URL shape, fallback)
#   tsc --noEmit                   (typecheck)
#   vitest run                     (unit tests; integration excluded)
```

Useful sub-commands: `npm run typecheck`, `npm test`, `npm run test:watch`, `npm run lint`,
`npm run verify:embed`.

The gate's `tsc --noEmit` typechecks the **app** only — the Playwright e2e suite (`e2e/`,
`playwright.config.ts`) is excluded so the lean build stays fast and green without
`@playwright/test` (which ships only as next's optional peer and is **not** in the lockfile, to keep
CI installs lean). To typecheck the e2e suite on demand, install Playwright first, then run its
dedicated config:

```sh
npm i -D @playwright/test   # not in the main install / lockfile by design
npx playwright install      # browser binaries (or `npx playwright install-deps` on Linux CI)
npm run typecheck:e2e       # tsc -p e2e/tsconfig.json --noEmit
```

`npm run typecheck:e2e` is intentionally kept **out** of `npm run gate` and the CI typecheck — e2e
stays typecheckable without bloating the main build.

## Deploy to production

The app builds to a standalone Node.js server bundle (`output: 'standalone'` in
[`next.config.ts`](next.config.ts)), so it runs anywhere that hosts a Node server — Vercel, a
container, or a plain VM.

```sh
make web-build         # cd web && npm run build
npm start              # serve the production build (next start) on PORT (default 3000)
```

**On a platform (Vercel / container / VM):** set the build command to `npm run build`, the output to
the standalone server, and copy **every** variable you use from `.env.example` into the platform's
environment settings (Vercel → Project → Settings → Environment Variables, or your container's env).
The `prebuild` step (`gen-deployments.mjs` + `replace-embed-addrs.js`) runs automatically on
`npm run build`; it bakes the `NEXT_PUBLIC_ROUTER_*` / `NEXT_PUBLIC_USDC_*` addresses into
`public/embed.js`, so those variables must be present **at build time**, not just at runtime.

A few deployment notes worth knowing:

- **`NEXT_PUBLIC_*` is public and build-time.** Anything prefixed `NEXT_PUBLIC_` is inlined into the
  client bundle and the embed — only addresses, RPC URLs, and public ids belong there. Server-only
  secrets (`CLAUDE_API_KEY`, `*_PRIVATE_KEY`, `*_SECRET`, `*_API_KEY`, …) must **never** carry that
  prefix and never reach the browser.
- **Security headers are applied to every route** by `next.config.ts` (CSP, `X-Frame-Options: DENY`,
  HSTS, `Referrer-Policy`, `Permissions-Policy`). `frame-ancestors 'none'` means the checkout cannot
  be iframed — don't override it to embed the hosted page; use `embed.js` instead.
- **`/api/ask` rate limiting:** behind a trusted CDN/proxy that sets the real client IP, set
  `ASK_TRUST_PROXY=true` so the limiter buckets per client; leave it blank otherwise (forwarding
  headers are client-spoofable).

## Environment variables

[`.env.example`](.env.example) is the full, authoritative list. The variables below are the ones a
basic checkout deployment needs; **all of them are optional** and every one fails soft when blank.

### Core checkout

| Variable | Required? | If unset |
|---|---|---|
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | No (defaults to `11155111`, Ethereum Sepolia) | The app uses the built-in default chain id (the embed keeps its own per-tag `data-chain-id` default). |
| `NEXT_PUBLIC_ROUTER_ADDRESS_<chainId>` | Per chain you support | That chain has **no router**: the checkout shows the USD price only — never a guessed address (LAW #4). |
| `NEXT_PUBLIC_USDC_ADDRESS_<chainId>` | Per chain you support | The settlement-token address is unknown for that chain; quotes/pay are disabled there. |
| `NEXT_PUBLIC_<CHAIN>_RPC_URL` | No (public RPCs default) | The app uses the built-in public RPC for that chain. |
| `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` | For merchant surfaces (onboard/dashboard) | Wallet auth on merchant routes can't initialize; buyer checkout is unaffected. |

The chain-id suffix matches the EVM chain id: `_5042002` (Arc testnet), `_84532` (Base Sepolia),
`_300` (zkSync Sepolia). Add a chain by setting its `NEXT_PUBLIC_ROUTER_ADDRESS_<id>` /
`NEXT_PUBLIC_USDC_ADDRESS_<id>` (and, optionally, its RPC) — no code change.

### Embed addresses (baked into `public/embed.js` at build time)

The embed is a vanilla IIFE that cannot read `process.env`, so its addresses are substituted from
these variables during `npm run build` by `scripts/replace-embed-addrs.js`. A variable left blank
keeps the placeholder in `embed.js`, which the embed treats as **"not deployed yet"** and falls back
to the USD-only label.

| Variable | Chain |
|---|---|
| `NEXT_PUBLIC_ROUTER_ARC` / `NEXT_PUBLIC_USDC_ARC` | Arc testnet (`5042002`, the embed's default) |
| `NEXT_PUBLIC_ROUTER_BASE_SEPOLIA` / `NEXT_PUBLIC_USDC_BASE_SEPOLIA` | Base Sepolia (`84532`) |
| `NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA` / `NEXT_PUBLIC_USDC_ZKSYNC_SEPOLIA` | zkSync Sepolia (`300`) |

### Optional feature seams

Each of these is dormant until configured and is documented in full (with fail-soft behavior) in
`.env.example`: the Claude assistant (`CLAUDE_API_KEY`, server-only), the x402 seller + AI payment
agent, ENS identity (`NEXT_PUBLIC_ENS_PARENT`, `NAMESTONE_API_KEY`), World ID
(`NEXT_PUBLIC_WORLD_APP_ID`), OIDC (`NEXT_PUBLIC_OIDC_CLIENT_ID`), funding/on-ramp, the ERC-7677
paymaster, and the payout-swap rails. Leave any of them blank to keep that feature off.

### Data persistence

Self-onboarded merchant **branding + checkout-slug routing** (and verification profiles, issued AI
API keys, the agent spend meter) are **in-memory unless a durable store is configured**. Set
`NULLIFIER_STORE_URL` (or the shared `DATABASE_URL`) — the same Postgres URL the replay store reads —
to persist them; with neither set these stores fail soft (in-memory, lost on restart / Cloud Run
scale-to-zero) and each logs a one-time boot warning so you know persistence is off. See the durable
replay-store block in [`.env.example`](.env.example).

## Embed integration

A merchant adds crypto checkout to **any** HTML page by pasting one tag — no build step, no npm, no
framework. The button reads the live crypto-equivalent price via a single `eth_call` to the router's
`quote` view function, then opens the hosted checkout on click.

```html
<!-- by numeric merchant id -->
<script
  src="https://your-deployment.example/embed.js"
  data-merchant="42"
  data-amount-usd="29.00"></script>
```

```html
<!-- white-label: by checkout slug (themed with the merchant's brand) -->
<script
  src="https://your-deployment.example/embed.js"
  data-slug="joes-barbershop"
  data-amount-usd="29.00"></script>
```

`src` must point at the `embed.js` served by your deployment — the checkout it opens is always
same-origin with the script. `data-merchant` (numeric) **or** `data-slug` is required, plus a
positive `data-amount-usd`.

| Attribute | Required | Meaning |
|---|---|---|
| `data-merchant` | one of merchant/slug | Numeric merchant id from `registerMerchant`. |
| `data-slug` | one of merchant/slug | Checkout slug; also fetches `/api/branding/<slug>` to theme the button and open `/c/<slug>`. |
| `data-amount-usd` | yes | Decimal USD price, e.g. `29.00`. Zero/malformed is rejected before any RPC call. |
| `data-chain-id` | no | EVM chain id; defaults to the embed's default chain when unset or unknown. |
| `data-label` | no | Button text; defaults to `Pay with Crypto`. |
| `data-theme` | no | `light` (default) or `dark`. |
| `data-container` | no | CSS selector of an element to inject the button into; defaults to in place. |

**Graceful degradation is mandatory:** the embed never crashes the host page. On any failure (no
router for the chain, RPC error, branding fetch failure) it falls back to a USD-only button label and
the default checkout path. The script holds no keys or secrets — it only calls a view function and
opens a URL.

## Layout

```
web/
├── app/            Next.js App Router — pages, checkout, dashboard, and /api routes
├── components/     React UI (checkout card, connect button, token picker, …)
├── lib/            Chain registry, contracts, quote/ENS/x402 helpers, embed config
├── public/embed.js The One-Tag Checkout embed (vanilla IIFE)
├── scripts/        Build/deploy helpers (gen-deployments, replace-embed-addrs, verify-embed)
├── test/ __tests__/ Vitest unit + integration tests
├── e2e/            Playwright journeys (*.spec.ts) + its own on-demand tsconfig
└── .env.example    The authoritative env-var reference (names only)
```

## License

MIT — same as the rest of the repo.
