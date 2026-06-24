/**
 * Hero.tsx — the top fold of the public marketing landing page.
 *
 * Pure presentational, server-renderable: no hooks, no client JS. It states the
 * product one-liner ("A do-it-all center to get you and your business onchain")
 * and frames the value prop, then hands the visitor straight to the primary CTA
 * (rendered separately by LandingCTA so the call-to-action lives in one place).
 *
 * Styling rides the existing brand chassis (globals.css / tailwind.config.ts):
 * the night-water `background`, `foreground` text, cyan `primary` accent, and
 * the `font-display` wordmark face — no new tokens introduced. The BrandMark
 * lockup is reused verbatim from components/BrandMark.tsx.
 */
import type { ReactNode } from 'react'

import { BrandMark } from '@/components/BrandMark'
import { LandingCTA } from '@/components/marketing/LandingCTA'

/** The product one-liner — the single sentence the page is built around. */
const ONE_LINER = 'A do-it-all center to get you and your business onchain'

export function Hero(): ReactNode {
  return (
    <section className="relative isolate overflow-hidden">
      {/*
       * Ambient cyan→teal glow behind the headline. Decorative only, so it is
       * aria-hidden and pointer-events-none; it never intercepts a click on the
       * CTA below it. Pure CSS gradient — no image request.
       */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-32 -z-10 mx-auto h-72 max-w-3xl rounded-full bg-gradient-to-r from-primary/25 via-accent/15 to-primary/25 blur-3xl"
      />

      <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 px-6 py-24 text-center sm:py-32">
        {/* Brand lockup — the same glyph + wordmark used across the app. */}
        <BrandMark size={24} />

        {/* Eyebrow: positions the product before the headline lands. */}
        <span className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Payments · Auth · Agents — one link, no contract code
        </span>

        {/* The headline IS the one-liner. font-display for the brand voice. */}
        <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-6xl">
          {ONE_LINER}
        </h1>

        {/* Sub-headline: what it means in plain terms. */}
        <p className="max-w-xl text-balance text-lg text-muted-foreground">
          Access0x1 is the open, on-chain layer for accepting USD-priced crypto,
          proving identity, and letting agents act on your behalf. Onboard once,
          share a link, get paid in USDC — zero custody, no smart-contract code
          to write.
        </p>

        {/* Primary call-to-action: deep-links to /onboard. */}
        <LandingCTA />
      </div>
    </section>
  )
}

export default Hero
