# Web App — Production Deploy + Ops Runbook

Operator guide for shipping and running the **Access0x1 hosted web app**
(`web/`, Next.js 15 App Router) in production. This is the **server runbook** —
it owns the Node process that serves the hosted checkout, the dashboard, the
`/api/*` routes (the Claude "Ask" endpoint, the x402 seller, the Dynamic agent,
the Unlink payout leg), and the one-tag `public/embed.js`.

> **Scope — this is NOT the contract deploy doc.** Deploying the on-chain
> `Access0x1Router` / `DeployAll` stack to a testnet is
> [`DEPLOY-TESTNETS.md`](DEPLOY-TESTNETS.md); the verified per-chain addresses
> live in [`CHAIN-ADDRESSES.md`](CHAIN-ADDRESSES.md). This document never
> deploys a contract and never moves money on-chain. It assumes the routers are
> already live and points the web app at them via `NEXT_PUBLIC_*` env (§3).
>
> **Integrator-facing env** (the `NEXT_PUBLIC_*` table a *consumer* of a
> self-hosted instance needs) is in [`QUICKSTART.md`](QUICKSTART.md#hosted-app--embedjs--next_public_-env).
> This doc is the **operator's** view: the full secret inventory, the build
> gate, header verification, health-checks, rollback, and on-call.

---

## Contents

1. [Hosting target + the build command](#1-hosting-target--the-build-command)
2. [The booth-install gate (before `next build`)](#2-the-booth-install-gate-before-next-build)
3. [Server-side env-var inventory](#3-server-side-env-var-inventory)
4. [Security-headers verification](#4-security-headers-verification)
5. [Health-check](#5-health-check)
6. [Rollback](#6-rollback)
7. [SRE on-call checklist](#7-sre-on-call-checklist)
8. [CDN / edge configuration — the locale contract](#8-cdn--edge-configuration--the-locale-contract)

---

## 1. Hosting target + the build command

### 1.1 Target: a long-lived Node server (EC2 / container), **not** a serverless host

The app **must** run as a persistent Node process, not on a per-request
serverless platform. Two hard reasons, both from the code:

- **`next.config.ts` sets `output: 'standalone'`** — `next build` emits a
  self-contained Node server bundle (`.next/standalone/server.js`) intended for
  "EC2/container deploys" (the comment says so verbatim). This is the same
  EC2-on-SSM pattern used for standalone Node deploys.
- **Server-only secrets + in-process state.** The Claude key, the Dynamic agent
  wallet, the Unlink payout key, and the x402 seller key (§3) live in the server
  process; the Dynamic agent persists `AGENT_WALLET_ID` and the in-memory
  spend-meter across requests within a process. A serverless host that re-cold-
  starts per request would lose that and fan the secrets out to every edge.

`reactStrictMode` is on and `serverExternalPackages: ['@anthropic-ai/sdk']`
keeps the Claude SDK (and the key it reads) out of every client bundle — that
guarantee only holds because the server is a single trusted process.

### 1.2 The build command

Run from `web/`. The npm `prebuild` script runs **automatically** before
`build` — do not skip it:

```sh
cd web
npm ci                 # clean, lockfile-exact install
npm run build          # runs prebuild (below) then `next build`
```

`prebuild` (package.json) does two things `next build` depends on:

1. `node scripts/gen-deployments.mjs` — regenerates `lib/deployments.ts` +
   `lib/currentBytecode.ts` from the Foundry `broadcast/` artifacts (the
   "Deployments" dashboard reads them; **no address is hand-typed**). If the
   maps are stale the dashboard shows wrong addresses — verify with
   `node scripts/gen-deployments.mjs --check` (exit 1 ⇒ stale).
2. `node scripts/replace-embed-addrs.js` — substitutes the `__PLACEHOLDER__`
   address tokens in `public/embed.js` from the `NEXT_PUBLIC_ROUTER_*` /
   `NEXT_PUBLIC_USDC_*` env (§3). **The build env must carry these or the
   shipped embed points at placeholders.**

### 1.3 Run the built server

`output: 'standalone'` produces a server that listens on `PORT` (default `3000`)
and binds `HOSTNAME` (set `0.0.0.0` behind a load balancer):

```sh
# the standalone bundle is self-contained; copy static + public alongside it
cp -r .next/static .next/standalone/.next/static
cp -r public        .next/standalone/public

PORT=3000 HOSTNAME=0.0.0.0 node .next/standalone/server.js
```

Put a TLS-terminating reverse proxy / CDN in front (nginx / ALB / CloudFront).
HSTS and the `ASK_TRUST_PROXY` IP-trust flag (§3) both assume that proxy.
**If that CDN caches HTML, read §8 before you point DNS at it** — locale
resolution depends on signals the CDN must forward *and* vary on.

### 1.4 The pre-ship gate (must be green before you deploy)

```sh
npm run gate     # node --check embed.js && verify:embed && tsc --noEmit && vitest run
npm run lint     # next lint (eslint: next/core-web-vitals)
npm run build    # the real production build must exit 0
```

`gate` is the same fast check the merge gate runs; `vitest` here includes
`__tests__/security-headers.test.ts` (§4). A red gate is a no-ship.

---

## 2. The booth-install gate (before `next build`)

Two payout/funding SDKs are **proprietary, booth-installed packages** that are
**absent from `package.json` on purpose**. Off a clean `main` they ship only as
local type shims (`types/unlink-sdk.d.ts`, `types/deposit-sdk.d.ts`) and are
marked webpack `commonjs` externals in `next.config.ts`, so `next build`
**succeeds without them** and their guarded loaders fail soft at request time:

| Package | Powers | Guarded loader (fails soft when absent) |
| --- | --- | --- |
| `@unlink-xyz/sdk` | Unlink **private payout leg** (server-only) | `lib/unlink/loadSdk.ts` → `UnlinkSdkUnavailableError` ("no funds moved") |
| `@swype-org/deposit` | one-tap **deposit funding** panel | `lib/funding/loadSdk.ts` → `DepositSdkUnavailableError` |

**The gate:** to ship those features *live*, install the package **into the
build** before `next build`, one at a time (deps law — never a bulk install):

```sh
# Unlink private payouts — install BEFORE `npm run build`
npm i @unlink-xyz/sdk@canary     # confirm the exact tag at the Unlink booth

# one-tap deposit funding (separate product — NOT the BlinkLabs RPC key)
npm i @swype-org/deposit          # confirm access at the Swype booth
```

Then set the matching server env (§3: `UNLINK_*`, `BLINK_*`). The externals
config means a build done *without* the package still passes — so a missing
booth install is **silent at build time** and only surfaces as a fail-soft
`*_unavailable` response in production. **Confirm the package is in
`node_modules` before you claim the private/deposit path is live.**

> Do **not** add these to `package.json` / the lockfile in the public repo —
> they are booth-gated and must not break a clean-`main` build for anyone.

---

## 3. Server-side env-var inventory

Names only — **never commit a value** (public repo; the PreToolUse guard + law
#5 block it). Set these in the deploy environment / a secrets manager, not in
`.env` in the tree. Canonical source: [`web/.env.example`](../web/.env.example).

Two classes:

- **`NEXT_PUBLIC_*` = PUBLIC** — inlined into the client bundle at build time.
  Safe to expose; they are addresses, chain ids, and public client/app ids.
- **everything else = SERVER SECRET** — read only in `/api/*` routes and
  scripts; must never reach a client bundle, `embed.js`, or a response body.

### 3.1 Secrets (SERVER-ONLY — leak = real damage)

| Var | Used by | Notes |
| --- | --- | --- |
| `CLAUDE_API_KEY` | `/api/ask` | **Dedicated, spend-capped** Anthropic key for "Ask Access0x1" — **NOT** the other app's key. `serverExternalPackages` keeps the SDK server-side; the browser only ever hits `/api/ask`. Rate-limit + cap spend. |
| `ASK_TRUST_PROXY` | `/api/ask` limiter | `"true"` **only** behind a trusted proxy/CDN that sets `x-real-ip` (or appends the real IP as the *last* `x-forwarded-for` hop). Blank/false ⇒ headers untrusted (spoofable) and everyone shares one rate bucket. Never trust the raw *first* `x-forwarded-for`. |
| `DYNAMIC_AUTH_TOKEN` | dynamic-agent | Server API token (not a user JWT); authenticates the node SDK once per process. |
| `WALLET_PASSWORD` | dynamic-agent | Encrypts the Dynamic MPC client key share. |
| `AGENT_INTERNAL_SECRET` | `/api/agent/pay` | Shared secret required as `x-internal-secret` — the route spends real USDC. **Blank ⇒ route FAILS CLOSED (503).** Set in prod. |
| `AGENT_ALLOW_INSECURE` | `/api/agent/pay` | local-dev ONLY fail-open. **Never set in production.** |
| `AP2_MANDATE_SECRET` | `/api/ap2/mandate` | Optional caller check; the route only derives (moves no money). |
| `SELLER_PRIVATE_KEY` | arc-x402 | Signs Circle Gateway withdraws (`/api/gateway/withdraw`). |
| `BUYER_PRIVATE_KEY` | local scripts only | Ephemeral buyer EOA for the `fund-gateway` / `demo-loop` local scripts. Not needed for serving. |
| `UNLINK_API_KEY` | unlink-private | `createUnlinkAdmin`; backend-only. Requires the §2 booth install to take effect. |
| `UNLINK_PAYOUT_PRIVATE_KEY` / `UNLINK_PRIVATE_PAY_KEY` | unlink-private | Server payout keys (transfer/withdraw only — zero custody). |
| `WORLD_SIGNING_KEY` | `/api/world/sign` | Signs the World ID RP request. Returned once at registration — persist it. |
| `NAMESTONE_API_KEY` | `/api/ens/subname` | Gasless subname WRITE. Blank ⇒ subname issuance is a clean no-op. |
| `ONRAMP_SERVER_KEY` | `/api/onramp/session` | Provider session-minting secret (some providers). Never in a response/redirect. |
| `UNISWAP_TRADING_API_KEY` | `/api/payout-swap` | Server-only `x-api-key`. Blank ⇒ Uniswap payout rails OFF. |
| `BLINK_RPC_URL` | payout-swap | BlinkLabs **value-recovery RPC** (`base.blinklabs.xyz/v1/<key>`) — the URL embeds a secret. NOT the deposit SDK. |
| `PAYOUT_SWAP_INTERNAL_SECRET` | `/api/payout-swap` | `x-internal-secret`. **Blank ⇒ FAILS CLOSED (503).** Set in prod. |
| `PAYOUT_SWAP_ALLOW_INSECURE` | `/api/payout-swap` | local-dev ONLY fail-open. **Never in production.** |

### 3.2 RPC URLs (mixed — the URL can embed a key)

| Var | Class | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_ARC_RPC_URL` · `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` · `NEXT_PUBLIC_ZKSYNC_SEPOLIA_RPC_URL` | **public** | Read RPC for the embed/dashboard `eth_call` quote. A *public* (keyless) endpoint per chain — do not put a key-bearing URL here, it ships to the browser. |
| `ARC_TESTNET_RPC_URL` | server | x402 seller / agent submit leg. |
| `ZKSYNC_SEPOLIA_RPC_URL` | server | zkSync classic-swap submit leg (`/api/payout-swap`). Blank ⇒ zkSync rail OFF. |

> **Alchemy/Tenderly key-bearing URLs are SECRETS** (the URL embeds the key) →
> use them for the **server-side** RPC vars only, never a `NEXT_PUBLIC_*` one.

### 3.3 Dynamic (auth + agent)

| Var | Class | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` | public | Wallet/auth environment for the hosted checkout provider. |
| `DYNAMIC_ENVIRONMENT_ID` | server | Same id the node agent SDK uses. |
| `DYNAMIC_JWT_ISSUER` / `DYNAMIC_JWT_AUDIENCE` | server | Pin the JWT to this environment (default from the env id). Set only to override a non-standard iss/aud. |
| `AGENT_WALLET_ID` | server | Persisted **after first boot** (`createWalletAccount`). Blank on first boot, then set it so restarts reuse the wallet. |
| `AGENT_DAILY_USD_CAP` · `AGENT_URL_ALLOWLIST` · `AGENT_REQUIRE_HUMAN` · `AGENT_TRIAL_CALLS` | server | Spend ceiling, x402 SSRF allowlist, World-ID human gate, trial-call count. |

(`DYNAMIC_AUTH_TOKEN`, `WALLET_PASSWORD` are secrets — §3.1.)

### 3.4 Walrus (decentralized hosting of the checkout/receipt blobs)

Consumed by `scripts/publish-checkout.mts` via `lib/walrus.ts`. **All public,
all optional** — blank falls back to the documented testnet defaults baked into
`lib/walrus.ts` (`WALRUS_TESTNET_PUBLISHER` / `WALRUS_TESTNET_AGGREGATOR`):

| Var | Notes |
| --- | --- |
| `WALRUS_PUBLISHER` | Publisher base URL. Blank ⇒ testnet default. |
| `WALRUS_AGGREGATOR` | Aggregator base URL. Blank ⇒ testnet default. |
| `WALRUS_EPOCHS` | Storage-epoch count (positive int). Mainnet bills WAL per epoch and needs a **funded** publisher you control — not a default. |

### 3.5 `NEXT_PUBLIC_*` contract addresses + chain config (PUBLIC, build-time)

The full integrator-facing table is in
[`QUICKSTART.md`](QUICKSTART.md#hosted-app--embedjs--next_public_-env). The
operator must set these **in the build env** (they bake into the client bundle
*and* into `embed.js` via `prebuild`):

| Var family | What it is |
| --- | --- |
| `NEXT_PUBLIC_ROUTER_ARC` · `_BASE_SEPOLIA` · `_ZKSYNC_SEPOLIA` (and `NEXT_PUBLIC_ROUTER_ADDRESS_<chainId>`) | Deployed `Access0x1Router` per chain (from the README Deployments table / `broadcast/`). |
| `NEXT_PUBLIC_USDC_*` / `NEXT_PUBLIC_USDC_ADDRESS_<chainId>` | Per-chain USDC. |
| `NEXT_PUBLIC_TOKEN_<SYM>_<chainId>` · `_FEED_<chainId>` | Allowlisted pay-in tokens + Chainlink feeds. A coin left blank shows DISABLED — never a guessed address. |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | Default settlement chain when a link/tag omits `chainId`. |
| `NEXT_PUBLIC_WORLD_APP_ID` · `NEXT_PUBLIC_WORLD_ENVIRONMENT` · `NEXT_PUBLIC_OIDC_CLIENT_ID` · `NEXT_PUBLIC_PAYMASTER_*` · `NEXT_PUBLIC_BLINK_*` · `NEXT_PUBLIC_ONRAMP_*` · `NEXT_PUBLIC_ENS_*` | Optional, env-gated feature seams — each blank ⇒ the feature is hidden / a clean no-op (fail-soft, law #4: never invent a value). |

> **No address is ever hardcoded** (guardrail #5): every address above is read
> from these vars or generated from `broadcast/` by `gen-deployments.mjs`.

---

## 4. Security-headers verification

`next.config.ts` exports `SECURITY_HEADERS` and applies the full set to **every**
route via `headers()` (`source: '/:path*'`). The set closes red-report R-3:
`Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options:
nosniff`, `Strict-Transport-Security` (2y, `includeSubDomains; preload`),
`Referrer-Policy: strict-origin-when-cross-origin`, and a locked-down
`Permissions-Policy`. The CSP carries `frame-ancestors 'none'`, `object-src
'none'`, `base-uri 'self'`, `form-action 'self'`, `default-src 'self'`.

### 4.1 Verify in CI / at build (the test is the contract)

`__tests__/security-headers.test.ts` pins the set is present, complete, and
applied to every path. It runs as part of `npm run gate`. Run it explicitly
before a ship:

```sh
cd web
npx vitest run __tests__/security-headers.test.ts
```

If you change a CSP source list or add an origin, **update the test in the same
change** — a red header test is a no-ship (it means a security header regressed).

### 4.2 Verify on the LIVE deployment (post-deploy smoke)

The test proves the *config*; this proves the *running server + proxy* actually
emit them (a misconfigured CDN can strip headers). After deploy:

```sh
curl -sSI https://<your-access0x1-host>/ | grep -iE \
  'content-security-policy|x-frame-options|x-content-type-options|strict-transport-security|referrer-policy|permissions-policy'
```

Expected: all six present; `X-Frame-Options: DENY`; HSTS with a `max-age` of
`63072000`. **HSTS is only honored over HTTPS** — confirm you hit the TLS
origin, not plain HTTP. A missing header on the live host but present in the test
⇒ the **proxy/CDN is stripping it**, not the app.

---

## 5. Health-check

The app has **no dedicated `/health` route** today. Use these probes:

| Probe | Command | Healthy signal |
| --- | --- | --- |
| **Liveness** (process up) | `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/` | `200` from the root page |
| **Headers** (config applied) | §4.2 `curl -sSI` | all six security headers present |
| **Ask endpoint configured** | `curl -fsS http://127.0.0.1:$PORT/api/ask -X POST -d '{}'` | a structured JSON error, **not** a 500 stack — and **never** leaks a key |
| **Money routes fail CLOSED** | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/agent/pay -X POST` | `503` when `AGENT_INTERNAL_SECRET` is unset — confirms the fail-closed guard, not an open spend path |
| **Deployments map fresh** | `node scripts/gen-deployments.mjs --check` (from `web/`) | exit `0` (non-zero ⇒ dashboard addresses stale) |

Wire the **liveness** probe into the load balancer / process supervisor. Treat a
non-`200` root or a stripped security header as **unhealthy → roll back (§6)**.

> Optional hardening for on-call: a thin `app/api/health/route.ts` returning
> `{ ok: true }` would give the LB a cheaper, body-light target than the full
> root page — flag it as a follow-up, not a blocker.

---

## 6. Rollback

The app is a stateless server bundle (zero on-chain custody, no DB migration on
the web tier) — **rollback is a redeploy of the previous build**, not a data
restore. Keep the last known-good artifact.

1. **Detect** — a health probe (§5) red, a spike in `/api/*` 5xx, a stripped
   header, or a `*_unavailable` flood (a booth SDK fell out / a secret unset).
2. **Roll back the release** — re-point the process supervisor / LB target group
   at the **previous standalone bundle** (the same atomic-release pattern the
   a standard `deploy-app` script uses: a new release dir + a symlink flip; rollback
   = flip the symlink back) and restart:
   ```sh
   PORT=3000 HOSTNAME=0.0.0.0 node <prev-release>/.next/standalone/server.js
   ```
3. **Re-verify** — run the §5 liveness + §4.2 header smoke against the rolled-back
   host before declaring recovery.
4. **If the cause is config, not code** — a missing/rotated secret (§3) — fix the
   env and **restart the process** (env is read at boot; the Dynamic agent reads
   `AGENT_WALLET_ID` and the spend cap at startup). No rebuild needed for a pure
   env fix unless a `NEXT_PUBLIC_*` value changed (those are baked at build —
   changing one requires a rebuild + redeploy).

**Never** roll back by weakening a guard (e.g. setting `*_ALLOW_INSECURE=true` or
clearing a fail-closed secret to "make it work") — that opens a real-money path.
Roll back the binary, then fix forward.

---

## 7. SRE on-call checklist

**On page / alert:**

- [ ] **Liveness** — root returns `200` (§5). If not → rollback (§6).
- [ ] **Security headers** — all six present on the live host (§4.2). Missing on
      live but green in the test ⇒ the **proxy/CDN is stripping them**, fix the
      proxy, not the app.
- [ ] **Money routes fail CLOSED** — `/api/agent/pay` and `/api/payout-swap`
      return `503` when their `*_INTERNAL_SECRET` is unset; **no
      `*_ALLOW_INSECURE` is `true` in prod** (that is a fail-open spend path).
- [ ] **Secrets present + scoped** — `CLAUDE_API_KEY`, `DYNAMIC_AUTH_TOKEN`,
      `WALLET_PASSWORD`, the Unlink/seller/payout keys are set in the server env
      and **not** in any `NEXT_PUBLIC_*` var or client bundle.
- [ ] **Claude spend** — the dedicated key's usage/cost is within cap; rate-limit
      live. A `/api/ask` cost spike ⇒ rotate the key + tighten the limiter;
      confirm `ASK_TRUST_PROXY` matches the actual proxy (a wrong value either
      buckets everyone together or trusts spoofable IPs).
- [ ] **Agent spend cap** — `AGENT_DAILY_USD_CAP` enforced; the meter is never
      negative; `AGENT_URL_ALLOWLIST` still lists only intended x402 origins.
- [ ] **Booth SDKs** — if private payouts / one-tap deposit are advertised as
      live, `@unlink-xyz/sdk` / `@swype-org/deposit` are in `node_modules` (§2);
      a `*_unavailable` response means the package fell out of the build.
- [ ] **Deployments dashboard** — `gen-deployments.mjs --check` exits `0`
      (addresses match `broadcast/`); the live "Deployments" view shows the
      MATCHES state, not DRIFTED.
- [ ] **RPC health** — the per-chain read RPCs (§3.2) answer; a dead RPC stalls
      the embed/dashboard quote. Fail over to the backup endpoint if configured.
- [ ] **TLS / HSTS** — the host is served over HTTPS (HSTS is HTTPS-only) and the
      cert is valid / not near expiry.

**Routine (every deploy):**

- [ ] `npm run gate` + `npm run lint` + `npm run build` green (incl. the header
      test).
- [ ] `prebuild` ran with the real `NEXT_PUBLIC_*` env (embed addresses are not
      placeholders — `npm run verify:embed`).
- [ ] Previous known-good release retained for one-flip rollback (§6).
- [ ] Post-deploy: §4.2 header smoke + §5 liveness against the live host.

**Escalate to the owner (the real gates — never self-serve):** anything touching
**mainnet**, rotating/spending a **real key**, a Claude/agent **spend** anomaly
that needs a billing change, or a **secret leak** (rotate the key immediately,
then page the owner).

---

## 8. CDN / edge configuration — the locale contract

The marketing pages render in the visitor's language. `resolveLocale()`
([`web/lib/i18n/pick-locale.ts`](../web/lib/i18n/pick-locale.ts)) takes **three**
inputs, wired to the request in
[`web/lib/i18n/locale.ts`](../web/lib/i18n/locale.ts):

| Signal | Kind | Source of truth |
| --- | --- | --- |
| `access0x1_lang` | **cookie** | `LOCALE_COOKIE`, [`web/lib/i18n/config.ts`](../web/lib/i18n/config.ts) |
| `Accept-Language` | request header | the browser |
| `CloudFront-Viewer-Country` | **CDN-generated** header | added by CloudFront only if the policy enables it |

Precedence: an explicit cookie choice wins; else a stated non-default browser
language; else geo *fills the gap only*; else `DEFAULT_LOCALE` (`en`). Geo never
overrides a stated language — it drives an ask-prompt instead.

### 8.1 The cookie name is a deploy-time contract

It is **`access0x1_lang`** — a custom name, so **no AWS *managed* origin-request
or cache policy covers it**. Both policies must be custom. Renaming the cookie
without updating the edge config produces no error anywhere; it silently serves
cached pages in the wrong language. `web/app/api/locale/__tests__/locale.route.test.ts`
asserts the literal name as a tripwire for exactly that.

### 8.2 Forwarding is only half the job — the cache key is the other half

An **origin request policy** controls what reaches the origin. A **cache policy**
controls what CloudFront varies its cache on. Getting only the first one right is
the classic failure: signals reach the app, the app renders Portuguese, CloudFront
caches that response against the bare URL, and **the next English visitor is served
the Portuguese page**. Cross-locale cache poisoning, no errors in any log.

Values in the **cache policy are forwarded to the origin automatically**, so put
the three varying signals there, and use the origin request policy for everything
else the app needs.

⚠️ **`Accept-Language` is high-cardinality.** Real browsers emit hundreds of
distinct values (`en-US,en;q=0.9,pt;q=0.8`, …). Putting it raw in the cache key
gives a near-zero hit ratio — a correct cache that never hits. Pick one:

- **(a) Don't cache locale-varying HTML.** Cache policy = *CachingDisabled* for
  the pages; cache `/_next/static/*` and `/public/*` normally. Simplest and always
  correct; the app is a long-lived Node server (§1.1), so origin load is fine.
  **Recommended unless HTML edge-caching is a measured requirement.**
- **(b) Normalize at the edge.** A CloudFront Function collapses the three signals
  into one low-cardinality header (e.g. `x-a0x1-locale: en|pt`) and *only that*
  goes in the cache key — two variants per URL instead of hundreds. More moving
  parts; do this only if (a) proves insufficient.

### 8.3 Do NOT forward the `Host` header to a Cloud Run origin

Cloud Run routes by `Host`. Forwarding the *viewer's* host makes the origin see
the CDN hostname and 404. This app **never reads `Host`** — no `headers().get('host')`,
no `x-forwarded-host`, no absolute-URL construction from the request — so
forwarding it has no upside. Omit it and let the CDN send the origin's own host.

### 8.4 Query strings must reach the origin

Checkout links, merchant params and the x402 routes all carry query strings. If
**neither** policy forwards them the app silently loses every parameter. Set the
origin request policy's query-string behaviour to **all** — that is independent of
what the cache varies on.

### 8.5 Verify before pointing DNS

Test on the `*.cloudfront.net` domain first, then cut over Route 53.

```sh
CF=https://<dist>.cloudfront.net

# 1. Default -> English.
curl -sI "$CF/" | grep -i 'content-language\|x-cache'

# 2. An explicit pt browser -> Portuguese.
curl -s -H 'Accept-Language: pt-PT,pt;q=0.9' "$CF/" | grep -o '<html[^>]*lang="[^"]*"'

# 3. The cookie overrides everything.
curl -s -H 'Cookie: access0x1_lang=pt' -H 'Accept-Language: en-US' "$CF/" \
  | grep -o '<html[^>]*lang="[^"]*"'

# 4. THE CACHE-POISONING CHECK: pt first, then en. If the second answer is
#    Portuguese, the cache key is wrong — fix §8.2 before going live.
curl -s -H 'Accept-Language: pt-PT' "$CF/" >/dev/null
curl -s -H 'Accept-Language: en-US'  "$CF/" | grep -o '<html[^>]*lang="[^"]*"'

# 5. Query strings survive the edge.
curl -s "$CF/api/health?probe=1" -o /dev/null -w '%{http_code}\n'
```

Check **4** is the one that matters. Run it twice — a cold cache can pass by
accident.
