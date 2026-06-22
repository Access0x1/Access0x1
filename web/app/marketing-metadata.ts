/**
 * marketing-metadata.ts — the typed, per-route SEO metadata helper.
 *
 * SOURCE OF TRUTH: web/marketing/seo.md (the SEO plan, §2 per-route table + §3
 * structured data). Every title / description / OpenGraph / Twitter-card string
 * and the JSON-LD blob below is copied VERBATIM from that file; the upstream copy
 * it quotes lives in marketing/messaging.md (the canonical messaging house).
 * When seo.md changes, change this file — never the other way around.
 *
 * WHY THIS FILE EXISTS (and what it deliberately does NOT do): seo.md §4 calls for
 * five client-only pages to get server `layout.tsx` wrappers plus an extended root
 * layout. Wiring those route files is a SEPARATE follow-up (it touches app/layout.tsx
 * and the route layouts, owned by a concurrent teammate). To avoid a file clash this
 * module ONLY exports the typed objects + builders; it imports nothing app-side and
 * mutates no route. The follow-up simply does, e.g.:
 *
 *     // app/layout.tsx        → export const metadata = rootMetadata
 *     // app/onboard/layout.tsx → export const metadata = onboardMetadata
 *     // app/c/[slug]/layout.tsx →
 *     //   export function generateMetadata({ params }) {
 *     //     return checkoutMetadata({ businessName, businessDescription, slug })
 *     //   }
 *     // and inject `softwareApplicationJsonLd` / `organizationJsonLd` as
 *     //   <script type="application/ld+json"> on the root layout.
 *
 * TRUTH-IN-SEO (money-safety invariant #4 + seo.md §status): the build is TESTNET-ONLY. No string
 * here implies mainnet, custody, or processed-volume. The copy says "testnet build"
 * wherever a reader could otherwise assume production — keep it that way.
 *
 * TYPING: every static export is `satisfies Metadata`, so it is checked against
 * Next.js's public Metadata contract while preserving the exact literal strings
 * (a plain `: Metadata` annotation would widen them). The JSON-LD blobs are plain
 * typed objects (schema.org has no first-party TS type shipped in this app).
 */

import type { Metadata } from 'next';

/**
 * The canonical production domain. Single source: web/lib/ap2/mandate.ts uses the
 * same `https://access0x1.xyz` origin for mandate URNs, and seo.md pins it as the
 * canonical domain. Kept as a bare constant (no trailing slash) so callers compose
 * absolute URLs predictably; the follow-up sets `metadataBase` from it ONCE on the
 * root layout, after which the relative OG/canonical paths below resolve correctly.
 */
export const SITE_ORIGIN = 'https://access0x1.xyz' as const;

/**
 * The Twitter handle to attribute cards to. seo.md §3.1 names the author as
 * `@vyperpilleddev`; the site/creator card uses the same handle until a dedicated
 * brand handle exists. (No `if`/conditional — declarative per the owner rule.)
 */
const TWITTER_HANDLE = '@vyperpilleddev' as const;

/**
 * Shared OpenGraph fields every page inherits (site name + type + locale). Per-route
 * objects spread this and then override `title` / `description` / `url` / `images`.
 * Typed via `satisfies` against the `openGraph` slot of {@link Metadata} so a bad
 * key is a compile error, not a silent no-op.
 */
const baseOpenGraph = {
  siteName: 'Access0x1',
  type: 'website',
  locale: 'en_US',
} satisfies NonNullable<Metadata['openGraph']>;

/**
 * Shared Twitter-card fields every page inherits. `summary_large_image` is the
 * 1200×630 card seo.md §3.6 produces OG art for. Per-route objects override
 * `title` / `description` / `images`.
 */
const baseTwitter = {
  card: 'summary_large_image',
  site: TWITTER_HANDLE,
  creator: TWITTER_HANDLE,
} satisfies NonNullable<Metadata['twitter']>;

/* ------------------------------------------------------------------------- *
 *  §2 — Per-route static metadata (copy VERBATIM from web/marketing/seo.md)  *
 * ------------------------------------------------------------------------- */

/**
 * Root / bare-domain metadata (seo.md §2 `/`). `/` itself is a server redirect with
 * no HTML, so this lives on the ROOT LAYOUT and is what social/search see for the
 * bare domain before the redirect resolves. `index, follow`.
 */
export const rootMetadata = {
  title: 'Accept USD-priced crypto with one link · Access0x1',
  description:
    'Onboard once, share a link, get paid in USDC. Zero custody — every payment settles ' +
    'merchant-to-payout in a single transaction. Open-source router. Testnet.',
  alternates: { canonical: `${SITE_ORIGIN}/` },
  robots: { index: true, follow: true },
  openGraph: {
    ...baseOpenGraph,
    title: 'Access0x1 — the non-custodial onchain checkout, in one link',
    description:
      'Payments + auth + agents on one open router. No contract code, no custody, ' +
      'USD-priced in USDC. Drop it into any app in five minutes.',
    url: `${SITE_ORIGIN}/`,
    images: [{ url: '/og/default.png', width: 1200, height: 630, alt: 'Access0x1' }],
  },
  twitter: {
    ...baseTwitter,
    title: 'Access0x1 — the non-custodial onchain checkout, in one link',
    description:
      'Payments + auth + agents on one open router. No contract code, no custody, ' +
      'USD-priced in USDC. Drop it into any app in five minutes.',
    images: ['/og/default.png'],
  },
} satisfies Metadata;

/**
 * `/onboard` — the conversion hub (seo.md §2 `/onboard`). Static copy → a sibling
 * server `layout.tsx` exports this; the client view renders unchanged. `index, follow`.
 */
export const onboardMetadata = {
  title: 'Create your crypto payment link · Access0x1',
  description:
    'Make it yours: set a name, a tagline, and a logo, then accept USDC with one link — ' +
    'no code, no contract, no gas to manage. Non-custodial. Testnet build.',
  alternates: { canonical: `${SITE_ORIGIN}/onboard` },
  robots: { index: true, follow: true },
  openGraph: {
    ...baseOpenGraph,
    title: 'Onboard in minutes — your branded USDC checkout link',
    description:
      'Register once, share one link, get paid in USDC. Zero custody, USD-priced via ' +
      'Chainlink. The non-custodial way to accept crypto.',
    url: `${SITE_ORIGIN}/onboard`,
    images: [{ url: '/og/onboard.png', width: 1200, height: 630, alt: 'Access0x1 — onboard' }],
  },
  twitter: {
    ...baseTwitter,
    title: 'Onboard in minutes — your branded USDC checkout link',
    description:
      'Register once, share one link, get paid in USDC. Zero custody, USD-priced via ' +
      'Chainlink. The non-custodial way to accept crypto.',
    images: ['/og/onboard.png'],
  },
} satisfies Metadata;

/**
 * `/dashboard` — authed/utility surface (seo.md §2 `/dashboard`). Robots is
 * `noindex, follow`: keep the personal surface out of the index, pass link equity.
 */
export const dashboardMetadata = {
  title: 'Dashboard · Access0x1',
  description:
    'Your Access0x1 dashboard: payments received in USDC, your live checkout link, and ' +
    'branding — all non-custodial. Funds settle straight to your wallet.',
  alternates: { canonical: `${SITE_ORIGIN}/dashboard` },
  robots: { index: false, follow: true },
  openGraph: {
    ...baseOpenGraph,
    title: 'Access0x1 dashboard',
    description:
      'Track USDC received and manage your checkout link. Zero custody — Access0x1 never ' +
      'holds your funds.',
    url: `${SITE_ORIGIN}/dashboard`,
    images: [{ url: '/og/default.png', width: 1200, height: 630, alt: 'Access0x1' }],
  },
  twitter: {
    ...baseTwitter,
    title: 'Access0x1 dashboard',
    description:
      'Track USDC received and manage your checkout link. Zero custody — Access0x1 never ' +
      'holds your funds.',
    images: ['/og/default.png'],
  },
} satisfies Metadata;

/**
 * `/ask` — the AI assistant / discovery hub (seo.md §2 `/ask`). `/ask` already
 * exports `metadata` today; the follow-up extends that object with these fields.
 * `index, follow`.
 */
export const askMetadata = {
  title: 'Ask Access0x1 — crypto payments & agents AI · Access0x1',
  description:
    'Ask anything about onchain payments, USDC, agents, and zero-custody commerce. ' +
    'Answers grounded in the open-source Access0x1 repo. Testnet build.',
  alternates: { canonical: `${SITE_ORIGIN}/ask` },
  robots: { index: true, follow: true },
  openGraph: {
    ...baseOpenGraph,
    title: 'Ask Access0x1 — answers about onchain payments & agent USDC',
    description:
      'A grounded AI assistant for the open Access0x1 stack: USD-priced crypto checkout, ' +
      'non-custodial settlement, and agent payments.',
    url: `${SITE_ORIGIN}/ask`,
    images: [{ url: '/og/ask.png', width: 1200, height: 630, alt: 'Ask Access0x1' }],
  },
  twitter: {
    ...baseTwitter,
    title: 'Ask Access0x1 — answers about onchain payments & agent USDC',
    description:
      'A grounded AI assistant for the open Access0x1 stack: USD-priced crypto checkout, ' +
      'non-custodial settlement, and agent payments.',
    images: ['/og/ask.png'],
  },
} satisfies Metadata;

/**
 * `/deployments` — the live-multichain proof surface (seo.md §2 `/deployments`).
 * A strong E-E-A-T/credibility signal for the positioning cluster. `index, follow`.
 */
export const deploymentsMetadata = {
  title: 'Live deployments — Arc, Base, zkSync · Access0x1',
  description:
    'See the Access0x1 router live across Arc, Base, and zkSync testnets — verified ' +
    'on-chain, read straight from each RPC in your browser. One router, every chain.',
  alternates: { canonical: `${SITE_ORIGIN}/deployments` },
  robots: { index: true, follow: true },
  openGraph: {
    ...baseOpenGraph,
    title: 'Access0x1 deployments — one router, verified on every chain',
    description:
      'Open-source, non-custodial payments router deployed across Arc, Base, and zkSync ' +
      'testnets. Addresses verified live, client-side.',
    url: `${SITE_ORIGIN}/deployments`,
    images: [
      { url: '/og/deployments.png', width: 1200, height: 630, alt: 'Access0x1 deployments' },
    ],
  },
  twitter: {
    ...baseTwitter,
    title: 'Access0x1 deployments — one router, verified on every chain',
    description:
      'Open-source, non-custodial payments router deployed across Arc, Base, and zkSync ' +
      'testnets. Addresses verified live, client-side.',
    images: ['/og/deployments.png'],
  },
} satisfies Metadata;

/* ------------------------------------------------------------------------- *
 *  §2 — Per-merchant dynamic metadata builders (templates from seo.md)       *
 * ------------------------------------------------------------------------- *
 *  /c/[slug] and /m/[merchantId] are PUBLIC, dynamic, per-merchant pages. The
 *  follow-up server layouts call these from `generateMetadata({ params })` with
 *  the branding row (web/lib/branding/response.ts already provides name +
 *  description). The {Business Name} / {Business description} placeholders in
 *  seo.md are interpolated here. SECURITY: merchant strings are user input — the
 *  builder does NOT pre-escape, since Next.js escapes metadata values when it
 *  serializes them into the document <head>; do NOT bypass that by injecting these
 *  into raw HTML elsewhere.
 */

/** The merchant facts a checkout metadata builder needs (from the branding row). */
export interface CheckoutMetadataInput {
  /** The readable business name (branding row `name`). */
  readonly businessName: string;
  /** The one-line business description (branding row `description`). */
  readonly businessDescription: string;
  /**
   * The human-readable slug, when the merchant has one. Drives the canonical URL:
   * a slug present → canonical is the brand `/c/{slug}` URL (the id page folds to
   * it); absent → the caller passes the self URL. Optional.
   */
  readonly slug?: string;
}

/**
 * Build the metadata for `/c/[slug]` — the branded hosted checkout (seo.md §2
 * `/c/[slug]`). The canonical is the brand slug URL; OG image falls back to
 * `/og/checkout.png` (the per-merchant OG is rendered separately via `next/og`).
 *
 * @param input - merchant name + description + slug from the branding row.
 * @returns the typed {@link Metadata} for the slug checkout page.
 */
export function checkoutMetadata(input: CheckoutMetadataInput): Metadata {
  const { businessName, businessDescription, slug } = input;
  const title = `Pay ${businessName} in USDC · Access0x1`;
  const description =
    `${businessDescription} — pay ${businessName} in USDC with one tap. USD-priced, ` +
    'settled in a single transaction. Non-custodial checkout by Access0x1.';
  const ogTitle = `Pay ${businessName} — USDC checkout`;
  const ogDescription =
    `${businessDescription} · Powered by Access0x1, the non-custodial onchain checkout.`;
  // Self URL when a slug exists; the caller without a slug should use checkoutMetadataById.
  const canonical = slug === undefined ? `${SITE_ORIGIN}/c` : `${SITE_ORIGIN}/c/${slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      ...baseOpenGraph,
      title: ogTitle,
      description: ogDescription,
      url: canonical,
      images: [{ url: '/og/checkout.png', width: 1200, height: 630, alt: ogTitle }],
    },
    twitter: {
      ...baseTwitter,
      title: ogTitle,
      description: ogDescription,
      images: ['/og/checkout.png'],
    },
  };
}

/** The merchant facts a `/m/[merchantId]` metadata builder needs. */
export interface CheckoutByIdMetadataInput {
  /** The on-chain merchant id (the address-bar / QR fallback URL segment). */
  readonly merchantId: string;
  /** The readable business name (branding row `name`). */
  readonly businessName: string;
  /**
   * The merchant's human-readable slug, when one exists. Present → the canonical
   * folds this id page to the brand `/c/{slug}` URL (duplicate-content
   * consolidation, seo.md §2 `/m/[merchantId]`); absent → canonical is self and
   * the page is itself indexable. Optional.
   */
  readonly slug?: string;
}

/**
 * Build the metadata for `/m/[merchantId]` — checkout by merchant id (seo.md §2
 * `/m/[merchantId]`). The id URL is the QR/address-bar fallback; the slug is the
 * brand URL. Canonical folds to `/c/{slug}` WHEN a slug exists, else points at
 * self (and only then is the id page indexed).
 *
 * @param input - merchant id + name, and the slug when the merchant has one.
 * @returns the typed {@link Metadata} for the id checkout page.
 */
export function checkoutMetadataById(input: CheckoutByIdMetadataInput): Metadata {
  const { merchantId, businessName, slug } = input;
  const title = `Pay ${businessName} in USDC · Access0x1`;
  const description =
    `Pay ${businessName} in USDC, USD-priced and settled in one transaction. ` +
    'Non-custodial checkout — funds go straight to the merchant. By Access0x1.';
  const ogTitle = `Pay ${businessName} — USDC checkout`;
  const ogDescription =
    `Non-custodial USDC checkout for ${businessName}. USD-priced via Chainlink, ` +
    'zero custody. Powered by Access0x1.';
  // Slug present → fold to the brand URL + rely on canonical (so leave id out of the
  // index); slug absent → self-canonical + indexable. Declarative ternary (no `if`).
  const hasSlug = slug !== undefined;
  const canonical = hasSlug ? `${SITE_ORIGIN}/c/${slug}` : `${SITE_ORIGIN}/m/${merchantId}`;
  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: !hasSlug, follow: true },
    openGraph: {
      ...baseOpenGraph,
      title: ogTitle,
      description: ogDescription,
      url: canonical,
      images: [{ url: '/og/checkout.png', width: 1200, height: 630, alt: ogTitle }],
    },
    twitter: {
      ...baseTwitter,
      title: ogTitle,
      description: ogDescription,
      images: ['/og/checkout.png'],
    },
  };
}

/**
 * All static per-route metadata objects, keyed by route. Convenience for the
 * follow-up wiring and for any test that asserts the table stays in sync with
 * seo.md. Dynamic per-merchant routes (`/c/[slug]`, `/m/[merchantId]`) are NOT
 * here — they are builders ({@link checkoutMetadata} / {@link checkoutMetadataById}),
 * not static objects.
 */
export const routeMetadata = {
  '/': rootMetadata,
  '/onboard': onboardMetadata,
  '/dashboard': dashboardMetadata,
  '/ask': askMetadata,
  '/deployments': deploymentsMetadata,
} as const;

/* ------------------------------------------------------------------------- *
 *  §3 — Structured data (JSON-LD), site-wide on the root layout             *
 * ------------------------------------------------------------------------- */

/**
 * The `SoftwareApplication` JSON-LD blob (seo.md §3.1) — the primary entity,
 * modelling Access0x1 as a free developer tool. Copied VERBATIM from seo.md. Per
 * that section: NO fabricated `aggregateRating` / `review` (invented rating markup
 * is a manual-action risk) — add those only when a real review corpus exists.
 *
 * The follow-up serializes this with `JSON.stringify` into a single
 * `<script type="application/ld+json">` on the root layout.
 */
export const softwareApplicationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Access0x1',
  applicationCategory: 'FinanceApplication',
  applicationSubCategory: 'Crypto payments / checkout SDK',
  operatingSystem: 'Web',
  url: SITE_ORIGIN,
  description:
    'Open-source, non-custodial onchain layer for payments, auth, and agents. Accept ' +
    'USD-priced crypto in USDC with one link — no contract code, zero custody.',
  softwareVersion: '0.1.0',
  isAccessibleForFree: true,
  license: 'https://opensource.org/license/mit',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  featureList: [
    'USD-priced crypto checkout (Chainlink quotes)',
    'One-link / one-tag hosted checkout',
    'Non-custodial settlement (zero custody)',
    'Agent payments in USDC (ERC-6909 PaymentLanes, ERC-7702 sessions)',
    'Multichain: Arc, Base, zkSync',
  ],
  author: { '@type': 'Person', name: 'Rensley R.', alternateName: '@vyperpilleddev' },
} as const;

/**
 * The `Organization` JSON-LD blob (seo.md §3.2) — site-wide, on the root layout.
 * Copied VERBATIM from seo.md. `sameAs` points at the public repo (the canonical
 * external identity). Serialized alongside {@link softwareApplicationJsonLd}.
 */
export const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Access0x1',
  url: SITE_ORIGIN,
  logo: `${SITE_ORIGIN}/og/logo.png`,
  sameAs: ['https://github.com/Access0x1/Access0x1'],
} as const;

/**
 * Both site-wide JSON-LD entities as one array. The follow-up can emit them as a
 * single `@graph`-style script or one script each; this is the ordered set seo.md
 * §3 recommends on the root layout (per-merchant `Organization` for `/c` and `/m`,
 * §3.4, is emitted by those route layouts, not here).
 */
export const siteJsonLd = [softwareApplicationJsonLd, organizationJsonLd] as const;
