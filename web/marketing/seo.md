<!--
  marketing/seo.md — Access0x1 SEO plan (Marketing & Growth)
  ----------------------------------------------------------
  Owner: SEO Lead. Scope: the hosted web app at web/ (Next.js 15, App Router).
  Canonical domain: https://access0x1.xyz  (source: web/lib/ap2/mandate.ts → DEFAULT origin).

  This is a PLAN, not an implementation. Every "WIRE LATER" note points engineering
  at the exact file to edit. Nothing here edits app code — by design.

  Why this lives in web/marketing/: the route-file references below are relative to
  this app, so the plan sits next to the surface it governs and stays in sync with it.

  Ground truth this plan is built on (verified against the codebase 2026-06-20):
    - Public routes: / · /onboard · /dashboard · /c/[slug] · /m/[merchantId] · /ask · /deployments
    - `/` is a server redirect (app/page.tsx): → /c/<FEATURED_MERCHANT_SLUG> when that
      env is set, else → /onboard. It renders NO HTML of its own.
    - Only the root layout (app/layout.tsx) and /ask (app/ask/page.tsx) export `metadata`
      today. ALL other public pages are `'use client'` + `dynamic(..., { ssr: false })`,
      so they cannot export `metadata`/`generateMetadata` until refactored (see §4).
    - No robots.txt, sitemap.xml, manifest, OpenGraph image, Twitter card, or JSON-LD
      exists yet. Everything OG/structured-data below is net-new.
    - Per-merchant branding (name / description / logoSvg) is already available server-side
      via web/lib/branding/response.ts → the data for dynamic /c and /m OG already exists.
-->

# Access0x1 — SEO Plan

**Product (one line):** an open-source, non-custodial onchain layer for **payments +
auth + agents** — a business onboards once, shares one link, and gets paid in USDC with
no contract code and zero custody. Positioned as the **non-custodial Stripe alternative**
for onchain payments, with first-class **agent (USDC) payments**.

**Primary domain:** `https://access0x1.xyz` · **Status:** testnet build (judged, public repo).

> Truth-in-SEO rule (matches the repo's "verify or it didn't happen" law): the build is
> **testnet-only**. No copy, title, meta, or structured-data field may imply mainnet,
> production custody, or processed-volume claims. Say "testnet build" where a reader could
> otherwise assume production.

---

## 1. ICPs and keyword clusters

Three ideal-customer profiles (ICPs), each anchored to one of the four seed phrases. The
fourth seed (`non-custodial stripe alternative`) is the cross-cutting **positioning** term
that every ICP converts on, so it gets its own cluster too.

### ICP A — The integrating developer  (seed: **crypto checkout SDK**)
Wants to drop crypto checkout into an existing app/site in minutes, no contract code.

| Tier | Keyword | Intent | Lands on |
|---|---|---|---|
| **Primary** | crypto checkout SDK | commercial / dev | `/` → `/onboard`, blog #1 |
| Long-tail | accept USDC in my web app | commercial | `/onboard`, blog #1 |
| Long-tail | drop-in crypto payment SDK react | commercial | blog #1 |
| Long-tail | embed crypto checkout one tag / one line | commercial | blog #1 |
| Long-tail | accept crypto payments no smart contract | informational→commercial | blog #1 |
| Long-tail | USD-priced crypto payment SDK | commercial | blog #1 |
| Long-tail | next.js crypto payment integration | commercial | blog #1 |
| Long-tail | chainlink USD price checkout | informational | blog #3 |

### ICP B — The crypto-native business / merchant  (seed: **onchain payment link**)
Solo operator / SMB that wants a shareable link to get paid in USDC, no engineering.

| Tier | Keyword | Intent | Lands on |
|---|---|---|---|
| **Primary** | onchain payment link | commercial | `/onboard`, `/c/[slug]`, blog #2 |
| Long-tail | get paid in USDC with a link | commercial | `/onboard`, blog #2 |
| Long-tail | create a crypto payment link free | commercial | `/onboard`, blog #2 |
| Long-tail | accept crypto payments without a website | commercial | blog #2 |
| Long-tail | USDC invoice link / crypto invoice link | commercial | blog #2 |
| Long-tail | hosted crypto checkout page | commercial | `/c/[slug]`, blog #2 |
| Long-tail | crypto payment link no fees no custody | commercial | blog #2 |
| Long-tail | Base / zkSync / Arc payment link | commercial | blog #2, blog #6 |

### ICP C — The agent / AI-payments builder  (seed: **agent payments USDC**)
Building autonomous agents that need to move money safely with a spend budget.

| Tier | Keyword | Intent | Lands on |
|---|---|---|---|
| **Primary** | agent payments USDC | commercial / dev | `/ask`, blog #4 |
| Long-tail | how do AI agents pay with crypto | informational | blog #4 |
| Long-tail | autonomous agent USDC payments | commercial | blog #4 |
| Long-tail | agent payment authorization onchain | informational | blog #4 |
| Long-tail | budget-scoped agent spend allowance | informational | blog #4 |
| Long-tail | ERC-6909 payment lanes | informational | blog #4, blog #5 |
| Long-tail | ERC-7702 agent session key payments | informational | blog #4 |
| Long-tail | x402 agent payments / machine payments USDC | informational | blog #4 |

### Cross-cutting — Positioning  (seed: **non-custodial stripe alternative**)
The comparison term every ICP searches when evaluating. Highest commercial intent.

| Tier | Keyword | Intent | Lands on |
|---|---|---|---|
| **Primary** | non-custodial stripe alternative | commercial | `/`, blog #5 |
| Long-tail | Stripe alternative for crypto | commercial | blog #5 |
| Long-tail | accept crypto without custody | commercial | blog #5 |
| Long-tail | self-custody payment processor | commercial | blog #5 |
| Long-tail | crypto payments no chargebacks no custody | commercial | blog #5 |
| Long-tail | open source payment gateway crypto | commercial | blog #5, `/deployments` |
| Long-tail | Stripe vs crypto checkout | informational | blog #5 |

**Cluster-to-route map (the hub-and-spoke spine):**
`/onboard` is the conversion hub for ICP A+B · `/ask` is the discovery hub for ICP C ·
the blog supplies the top-of-funnel spokes · `/deployments` and `/c/[slug]` are the
proof/credibility surfaces that back the positioning cluster.

---

## 2. Per-route title / meta-description / OG table

Length discipline: **titles ≤ 60 chars**, **meta descriptions 140–160 chars**. The brand
suffix `· Access0x1` is included in the count. OG title may be longer than the `<title>`.

> Engineering note carried into every row: the canonical `metadataBase` (see §4) must be
> set ONCE on the root layout so every relative OG/canonical URL below resolves correctly.

### `/` — root (server redirect, no own HTML)
- **Behavior:** `app/page.tsx` 301/redirects to `/c/<featured>` or `/onboard`. It has no
  rendered content, so it needs **no per-page metadata** — but it MUST NOT be the indexed
  homepage. The marketing/brand metadata below lives on the **root layout** (`app/layout.tsx`)
  and is what social/search see for the bare domain before the redirect resolves.
- **Title:** `Accept USD-priced onchain payments with one link · Access0x1`
- **Meta:** `Onboard once, share a link, get paid in USDC. Zero custody — every payment settles merchant-to-payout in a single transaction. Open-source router. Testnet.`
- **OG title:** `Access0x1 — the non-custodial onchain checkout, in one link`
- **OG description:** `Payments + auth + agents on one open router. No contract code, no custody, USD-priced in USDC. Drop it into any app in five minutes.`
- **OG image:** `/og/default.png` (1200×630, brand wordmark + tagline — see §3.4)
- **Canonical:** `https://access0x1.xyz/`
- **Robots:** `index, follow`
- ✏️ **WIRE LATER:** `app/layout.tsx` already has `title` + `description`; extend its
  `metadata` with `metadataBase`, `openGraph`, `twitter`, `alternates.canonical`. Adopt the
  titles above (current layout title is close; align to the ≤60-char version).

### `/onboard` — create your branded checkout (CONVERSION HUB)
- **Title:** `Create your USDC payment link · Access0x1`
- **Meta:** `Make it yours: set a name, a tagline, and a logo, then accept USDC with one link — no code, no contract, no gas to manage. Non-custodial. Testnet build.`
- **OG title:** `Onboard in minutes — your branded USDC checkout link`
- **OG description:** `Register once, share one link, get paid in USDC. Zero custody, USD-priced via Chainlink. Zero-custody by design.`
- **OG image:** `/og/onboard.png`
- **Canonical:** `https://access0x1.xyz/onboard`
- **Robots:** `index, follow`
- ✏️ **WIRE LATER (refactor required):** page is `'use client'` (`app/onboard/page.tsx`).
  Add a sibling **server** `layout.tsx` under `app/onboard/` that exports static `metadata`
  (the client view is unchanged). Static copy, so no `generateMetadata` needed.

### `/dashboard` — merchant dashboard (authed / utility)
- **Title:** `Dashboard · Access0x1`
- **Meta:** `Your Access0x1 dashboard: payments received in USDC, your live checkout link, and branding — all non-custodial. Funds settle straight to your wallet.`
- **OG title:** `Access0x1 dashboard`
- **OG description:** `Track USDC received and manage your checkout link. Zero custody — Access0x1 never holds your funds.`
- **OG image:** `/og/default.png`
- **Canonical:** `https://access0x1.xyz/dashboard`
- **Robots:** `noindex, follow`  ← personal/utility surface; keep out of the index, pass link equity.
- ✏️ **WIRE LATER (refactor required):** `'use client'` page. Add `app/dashboard/layout.tsx`
  (server) exporting `metadata` **with `robots: { index: false, follow: true }`**.

### `/c/[slug]` — branded hosted checkout (PUBLIC, dynamic per merchant)
- **Title (template):** `Pay {Business Name} in USDC · Access0x1`
- **Meta (template):** `{Business description} — pay {Business Name} in USDC with one tap. USD-priced, settled in a single transaction. Non-custodial checkout by Access0x1.`
- **OG title (template):** `Pay {Business Name} — USDC checkout`
- **OG description (template):** `{Business description} · Powered by Access0x1, the non-custodial onchain checkout.`
- **OG image (template):** dynamically rendered from the merchant's `logoSvg` + name
  (data already exists in `web/lib/branding/response.ts`); fall back to `/og/checkout.png`.
- **Canonical:** `https://access0x1.xyz/c/{slug}`
- **Robots:** `index, follow` (this is the merchant's public storefront — the strongest
  long-tail/branded-traffic asset; one indexable page per onboarded business).
- ✏️ **WIRE LATER (refactor required):** `'use client'` page (`app/c/[slug]/page.tsx`). Add
  `app/c/[slug]/layout.tsx` (server) with **`generateMetadata({ params })`** that reads the
  branding row (reuse the `/api/branding/[slug]` data path) to fill `{Business Name}` and
  `{Business description}`. Use `next/og` (`ImageResponse`) for the per-merchant OG image at
  `app/c/[slug]/opengraph-image.tsx`. Sanitize/escape merchant strings (they're user input).

### `/m/[merchantId]` — checkout by merchant id (PUBLIC, dynamic, canonical-folded)
- **Title (template):** `Pay {Business Name} in USDC · Access0x1`
- **Meta (template):** `Pay {Business Name} in USDC, USD-priced and settled in one transaction. Non-custodial checkout — funds go straight to the merchant. By Access0x1.`
- **OG title (template):** `Pay {Business Name} — USDC checkout`
- **OG description (template):** `Non-custodial USDC checkout for {Business Name}. USD-priced via Chainlink, zero custody. Powered by Access0x1.`
- **OG image (template):** same dynamic merchant OG as `/c/[slug]`; fallback `/og/checkout.png`.
- **Canonical:** **point to `/c/{slug}` when the merchant HAS a slug**, else self
  (`https://access0x1.xyz/m/{merchantId}`). The slug page and the id page are the same
  checkout for the same merchant → fold duplicate content to the human-readable slug.
- **Robots:** `index, follow` only when no slug exists; otherwise rely on the canonical to
  consolidate. (The numeric-id URL is the address-bar/QR fallback; the slug is the brand URL.)
- ✏️ **WIRE LATER (refactor required):** `'use client'` page (`app/m/[merchantId]/page.tsx`).
  Add `app/m/[merchantId]/layout.tsx` (server) with `generateMetadata` that resolves the
  merchant, sets `alternates.canonical` to the slug URL when present, and reuses the same
  dynamic OG. Data path: `/api/branding/by-merchant/[id]`.

### `/ask` — Ask Access0x1 (AI assistant, DISCOVERY HUB for ICP C)
- **Title:** `Ask Access0x1 — onchain payments & agents AI · Access0x1`
  - (current code title `Ask Access0x1 — AI assistant` is fine; the above adds keyword reach.)
- **Meta:** `Ask anything about onchain payments, USDC, agents, and zero-custody commerce. Answers grounded in the open-source Access0x1 repo. Testnet build.`
- **OG title:** `Ask Access0x1 — answers about onchain payments & agent USDC`
- **OG description:** `A grounded AI assistant for the open Access0x1 stack: USD-priced onchain checkout, non-custodial settlement, and agent payments.`
- **OG image:** `/og/ask.png`
- **Canonical:** `https://access0x1.xyz/ask`
- **Robots:** `index, follow`
- ✏️ **WIRE LATER:** `/ask` is a server component that ALREADY exports `metadata`
  (`app/ask/page.tsx`) — lowest-friction route. Just extend the existing object with
  `openGraph`/`twitter`/`alternates`. No refactor needed.

### `/deployments` — live multichain deployments (PROOF surface)
- **Title:** `Live deployments — Arc, Base, zkSync · Access0x1`
- **Meta:** `See the Access0x1 router live across Arc, Base, and zkSync testnets — verified on-chain, read straight from each RPC in your browser. One router, every chain.`
- **OG title:** `Access0x1 deployments — one router, verified on every chain`
- **OG description:** `Open-source, non-custodial payments router deployed across Arc, Base, and zkSync testnets. Addresses verified live, client-side.`
- **OG image:** `/og/deployments.png`
- **Canonical:** `https://access0x1.xyz/deployments`
- **Robots:** `index, follow` (strong E-E-A-T/credibility signal for the positioning cluster).
- ✏️ **WIRE LATER (refactor required):** `'use client'` page (`app/deployments/page.tsx`).
  Add `app/deployments/layout.tsx` (server) exporting static `metadata`.

**Summary of robots policy:** index `/onboard`, `/c/[slug]`, `/m/[merchantId]` (when no
slug), `/ask`, `/deployments`, and the bare domain. `noindex` `/dashboard` and the authed
`/settings/*`, `/admin`, `/verify` utility routes. `/` self-resolves via redirect; never let
it be the indexed homepage — the layout metadata carries the homepage SERP listing.

---

## 3. Structured data (JSON-LD)

All JSON-LD is injected server-side as a `<script type="application/ld+json">`. None exists
today. Recommended graph:

### 3.1 `SoftwareApplication` (site-wide, on the root layout)
The primary entity. Models Access0x1 as a free developer tool.

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Access0x1",
  "applicationCategory": "FinanceApplication",
  "applicationSubCategory": "Onchain payments / checkout SDK",
  "operatingSystem": "Web",
  "url": "https://access0x1.xyz",
  "description": "Open-source, non-custodial onchain layer for payments, auth, and agents. Accept USD-priced payments in USDC with one link — no contract code, zero custody.",
  "softwareVersion": "0.1.0",
  "isAccessibleForFree": true,
  "license": "https://opensource.org/license/mit",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "featureList": [
    "USD-priced onchain checkout (Chainlink-interface price feeds)",
    "One-link / one-tag hosted checkout",
    "Non-custodial settlement (zero custody)",
    "Agent payments in USDC (ERC-6909 PaymentLanes, ERC-7702 sessions)",
    "Multichain: Arc, Base, zkSync"
  ],
  "author": { "@type": "Organization", "name": "Access0x1" }
}
```
> Do **not** add fabricated `aggregateRating` / `review` — there is no real review corpus,
> and invented rating markup is a manual-action risk. Add it only when real reviews exist.

### 3.2 `Organization` (site-wide, on the root layout)
```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Access0x1",
  "url": "https://access0x1.xyz",
  "logo": "https://access0x1.xyz/og/logo.png",
  "sameAs": ["https://github.com/Access0x1/Access0x1"]
}
```

### 3.3 `WebSite` + `SearchAction` (optional, root layout)
Wire the sitelinks search box ONLY if `/ask` can answer a `?q=` query string directly;
otherwise omit (don't mark up a search box that 404s).

### 3.4 Per-merchant `Organization` on `/c/[slug]` and `/m/[merchantId]`
On a branded checkout, emit a lightweight `Organization` for the merchant (name +
description + logo from the branding row) so the merchant's brand can earn its own
knowledge-panel signals. Keep it minimal; never assert payment-method or rating data.

### 3.5 Article / FAQ on blog posts (§6)
Each blog post emits `BlogPosting` (or `TechArticle` for the dev-deep posts). Posts written
in a Q&A shape additionally emit `FAQPage` to compete for "People Also Ask" / AI-overview
snippets — high leverage for the informational long-tail.

### 3.6 OG image assets to produce (referenced above)
`/og/default.png`, `/og/onboard.png`, `/og/ask.png`, `/og/deployments.png`,
`/og/checkout.png` (static 1200×630, brand colors per BRAND.md). Dynamic per-merchant OG
for `/c` and `/m` is generated at request time via `next/og` `ImageResponse`.

---

## 4. Engineering wiring checklist (files to touch — NOT touched here)

The single biggest SEO blocker: **five public pages are client-only (`ssr: false`)**, so
they ship with only the generic layout title and no per-page metadata or OG. Fix pattern:
add a **server `layout.tsx`** beside each client `page.tsx` and export `metadata` /
`generateMetadata` there — the existing client view component renders unchanged inside it.

| File to add / edit | What to wire | New refactor? |
|---|---|---|
| `app/layout.tsx` | Add `metadataBase: new URL('https://access0x1.xyz')`, `openGraph`, `twitter`, `alternates.canonical`, and the site-wide JSON-LD (§3.1–3.3). Align title to §2. | edit existing |
| `app/onboard/layout.tsx` | NEW server layout → static `metadata` (§2). | yes |
| `app/dashboard/layout.tsx` | NEW server layout → `metadata` with `robots:{ index:false }`. | yes |
| `app/c/[slug]/layout.tsx` | NEW server layout → `generateMetadata({params})` from branding; per-merchant JSON-LD (§3.4). | yes |
| `app/c/[slug]/opengraph-image.tsx` | NEW dynamic OG via `next/og` (merchant logo + name). | yes |
| `app/m/[merchantId]/layout.tsx` | NEW server layout → `generateMetadata` + canonical-to-slug folding. | yes |
| `app/m/[merchantId]/opengraph-image.tsx` | NEW dynamic OG (shared with /c). | yes |
| `app/ask/page.tsx` | EXTEND existing `metadata` with `openGraph`/`twitter`/`alternates`. | edit existing |
| `app/deployments/layout.tsx` | NEW server layout → static `metadata` (§2). | yes |
| `app/robots.ts` | NEW — allow indexable routes, disallow `/dashboard`, `/settings/*`, `/admin`, `/api/*`, `/verify`; point to sitemap. | yes |
| `app/sitemap.ts` | NEW — static routes + dynamically enumerate `/c/[slug]` from the branding store. | yes |
| `app/manifest.ts` | NEW — name, theme color, icons (also helps PWA/social). | yes |
| `public/og/*.png` | NEW static OG images (§3.6). | assets |

Guardrails for engineering: set `metadataBase` once (not per-route); escape all
user-supplied merchant strings before they enter `<title>`/OG; never emit metadata that
implies mainnet/custody/volume.

---

## 5. Internal-linking plan

The site is conversion-app-shaped (few pages, deep utility), so internal links must do the
top-of-funnel→conversion work the blog can't do alone. Hub-and-spoke around `/onboard`.

**Persistent global nav / footer (every page):**
`/onboard` (primary CTA), `/ask`, `/deployments`, `Docs`/GitHub, `Blog`. Use descriptive,
keyword-bearing anchor text — e.g. "Create your payment link" (→ `/onboard`), "Live on Arc,
Base & zkSync" (→ `/deployments`), not "click here".

**Directional rules:**
- **`/c/[slug]` and `/m/[merchantId]` → `/onboard`**: the "Powered by Access0x1" footer on
  every branded checkout links to `/onboard` with anchor "Get your own payment link." This
  turns every merchant's organic/branded traffic into top-of-funnel for us. Highest-leverage
  internal link in the whole site (it scales with every business onboarded).
- **`/m/[merchantId]` → `/c/[slug]`**: canonical + a visible link when a slug exists
  (consolidate to the brand URL).
- **`/deployments` → `/onboard`** ("Deploy your checkout") and **→ `/ask`** ("Ask how it
  works") — convert credibility traffic.
- **`/ask` → `/onboard`** and **→ blog**: the assistant's suggested-question chips and
  answer footers deep-link to the relevant blog post and to onboarding.
- **Blog → app**: every post ends with a contextual CTA to `/onboard` (commercial posts) or
  `/ask` (informational posts), and links sideways to 2 sibling posts in the same cluster.
- **Blog → blog (cluster mesh)**: each cluster has one pillar post that links to its spokes
  and back, so link equity concentrates on the pillar (the term we most want to rank).

**Pillar mapping (the page we point the most internal links at, per cluster):**
- ICP A pillar → blog #1 (checkout SDK) · ICP B pillar → blog #2 (payment link) ·
  ICP C pillar → blog #4 (agent payments) · Positioning pillar → blog #5 (Stripe alternative).

---

## 6. Content / blog backlog (6 posts)

Each post targets one cluster, carries a clear primary keyword, and earns its internal links
per §5. All copy stays testnet-honest. Suggested order = by funnel + ranking leverage.

| # | Working title | Cluster / ICP | Primary keyword | Secondary keywords | Format / schema | Primary CTA |
|---|---|---|---|---|---|---|
| 1 | **Add a crypto checkout to any app in 5 minutes (no smart contract)** | A — developer | crypto checkout SDK | accept USDC in my app · drop-in crypto SDK · one-tag embed | TechArticle, runnable quickstart + code | `/onboard` |
| 2 | **How to create an onchain payment link and get paid in USDC** | B — merchant | onchain payment link | crypto payment link free · get paid in USDC · no website | How-to (FAQPage), step-by-step w/ screenshots | `/onboard` |
| 3 | **USD-priced crypto: pricing checkout in dollars with Chainlink** | A — developer | USD-priced crypto payment | chainlink USD checkout · stable pricing crypto · price feed in the pay tx | TechArticle, diagram of quote-in-tx | `/ask` |
| 4 | **How AI agents pay with USDC: budgets, sessions, and lanes** | C — agent | agent payments USDC | autonomous agent payments · ERC-7702 session · ERC-6909 lanes · x402 | TechArticle + FAQPage | `/ask` |
| 5 | **The non-custodial Stripe alternative for crypto payments** | Positioning | non-custodial stripe alternative | Stripe alternative crypto · accept crypto without custody · no chargebacks | Comparison article (FAQPage), honest feature table | `/onboard` |
| 6 | **One router, every chain: accepting USDC on Arc, Base & zkSync** | B + Positioning | multichain crypto payments | Base payment link · zkSync USDC · Arc checkout · one router | TechArticle, links to `/deployments` proof | `/deployments` |

**Backlog notes:**
- Post #1 and #5 are the two highest-commercial-intent pillars — write them first.
- Post #5's comparison table must be scrupulously fair (real Stripe features acknowledged):
  fairness is both an SEO trust signal and brand-safety. No false "Stripe can't do X."
- Posts #3, #4 carry the technical depth that earns dev backlinks and AI-overview citations;
  keep them grounded in the actual contracts (`PaymentLanes`, `SessionGrant`, `OracleLib`).
- Every post: one H1 = the primary keyword phrase, primary keyword in the first 100 words,
  URL slug = the keyword (e.g. `/blog/onchain-payment-link`), and a self-referential canonical.

---

## 7. Measurement (how we'll know it worked)

- **Index coverage:** all 6 indexable route patterns + every published merchant `/c/[slug]`
  present in Search Console; `/dashboard` and utility routes correctly excluded.
- **Rank tracking:** the 4 primary keywords (one per cluster) + top-3 long-tails each.
- **Conversion proxy:** organic sessions → `/onboard` starts (the one event that matters).
- **Snippet wins:** FAQ/AI-overview appearances for the informational posts (#2, #4, #5).
- **Re-audit cadence:** revisit titles/meta after the first 90 days of impression data; tune
  CTR on the positioning cluster first (highest commercial value).

<!--
  END marketing/seo.md
  Nothing in this file edits app code. Hand the §4 checklist to engineering to wire the
  metadata/OG/JSON-LD/robots/sitemap. Keep this plan in sync when routes change.
-->
