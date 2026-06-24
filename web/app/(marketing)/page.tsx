import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { BrandMark } from '@/components/BrandMark'
import { Hero } from '@/components/marketing/Hero'
import { FeatureGrid } from '@/components/marketing/FeatureGrid'
import { IntegrationStrip } from '@/components/marketing/IntegrationStrip'
import { LandingCTA } from '@/components/marketing/LandingCTA'

/**
 * The public marketing landing page (route group `(marketing)`).
 *
 * This is a Server Component with NO client JavaScript — it statically renders
 * to HTML so it is fast, crawlable, and cacheable. It composes the marketing
 * sections (Hero → IntegrationStrip → FeatureGrid → closing CTA), each of which
 * is itself static and reuses the app's shadcn `components/ui/*` primitives and
 * the brand tokens from globals.css / tailwind.config.ts.
 *
 * Routing note: `(marketing)` is a Next.js route group — the parentheses do not
 * add a URL segment, so this is the deployment's standalone landing surface. The
 * root redirect (`app/page.tsx`, owned separately) governs where a bare `/` sends
 * fresh visitors; this file is the landing it can point at. Every primary action
 * deep-links to `/onboard` via <LandingCTA />.
 *
 * `force-static` is declared explicitly so a future client-only import never
 * silently opts the page into dynamic rendering.
 */
export const dynamic = 'force-static'

export const metadata: Metadata = {
  title: 'Access0x1 — a do-it-all center to get you and your business onchain',
  description:
    'Access0x1 is the open, on-chain layer for payments, auth, and agents. Accept ' +
    'USD-priced crypto with one link, prove identity with ENS, and let agents act ' +
    'within scoped grants — zero custody, no contract code. Live on Arc, Base, and ' +
    'zkSync, powered by Chainlink.',
}

export default function MarketingPage(): ReactNode {
  return (
    <main className="flex min-h-screen flex-col">
      {/* Top fold: the one-liner + primary CTA. */}
      <Hero />

      {/* Trust strip: Chainlink + the settlement chains. */}
      <IntegrationStrip />

      {/* The capability grid across the 12-contract surface. */}
      <FeatureGrid />

      {/* Closing call-to-action — a second, explicit path into onboarding. */}
      <section className="mx-auto w-full max-w-3xl px-6 pb-28 pt-8 text-center">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Get onchain in under two minutes
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-balance text-muted-foreground">
          No code, no contract to deploy, no gas to manage. Set your name, share
          your link, get paid in USDC.
        </p>
        <LandingCTA className="mt-8" />
      </section>

      {/* Minimal footer: the brand lockup, consistent with the rest of the app. */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8">
          <BrandMark size={16} />
          <p className="text-xs text-muted-foreground">
            Open source · zero custody · testnet-only
          </p>
        </div>
      </footer>
    </main>
  )
}
