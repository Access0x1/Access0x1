import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'

import { BrandMark } from '@/components/BrandMark'
import { Hero } from '@/components/marketing/Hero'
import { FeatureGrid } from '@/components/marketing/FeatureGrid'
import { IntegrationStrip } from '@/components/marketing/IntegrationStrip'
import { LandingCTA } from '@/components/marketing/LandingCTA'

/**
 * Root entry point ("/") — the public marketing landing.
 *
 * This is the rail's front door: the umbrella pitch ("the open-source rail apps
 * build on") + ETHGlobal credibility, with explicit CTAs into /onboard. It used
 * to redirect straight to /onboard, which buried the landing; the landing IS the
 * public face, so it renders here.
 *
 * A hosted instance can still feature ONE business as its default brand: when
 * `FEATURED_MERCHANT_SLUG` is set (the same env that seeds the branding row —
 * see lib/branding/seed.ts), the root sends visitors straight to that business's
 * branded checkout (`/c/<slug>`). `/onboard` stays reachable directly.
 */
export const metadata: Metadata = {
  title: 'Access0x1 — a do-it-all center to get you and your business onchain',
  description:
    'Access0x1 is the open, on-chain layer for payments, auth, and agents. Accept ' +
    'USD-priced crypto with one link, prove identity with ENS, and let agents act ' +
    'within scoped grants — zero custody, no contract code. Live on Arc, Base, and ' +
    'zkSync, powered by Chainlink.',
}

export default function Home(): ReactNode {
  const featuredSlug = (process.env.FEATURED_MERCHANT_SLUG ?? '').trim()
  if (featuredSlug) {
    redirect(`/c/${encodeURIComponent(featuredSlug)}`)
  }

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
