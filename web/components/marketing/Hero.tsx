/**
 * Hero.tsx — the top fold of the public marketing landing page.
 *
 * Pure presentational, server-renderable: no hooks, no client JS. It states the
 * product one-liner and frames the value prop, then hands the visitor straight
 * to the primary CTA (rendered by LandingCTA so the call-to-action lives in one
 * place).
 *
 * All copy comes from the active locale dictionary (`hero` + `cta` slices),
 * passed down from the server-rendered page. Styling rides the existing brand
 * chassis — no new tokens introduced.
 */
import type { ReactNode } from 'react'

import { BrandMark } from '@/components/BrandMark'
import { CalcadaBackdrop } from '@/components/marketing/Calcada'
import { LandingCTA } from '@/components/marketing/LandingCTA'
import type { Dictionary } from '@/lib/i18n/get-dictionary'

export interface HeroProps {
  hero: Dictionary['hero']
  cta: Dictionary['cta']
}

export function Hero({ hero, cta }: HeroProps): ReactNode {
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

      {/*
       * The calçada layer — Lisbon's hand-set pavement as the hero's ground:
       * a cobbled limestone field and the basalt medallion whose geometry IS
       * the brand glyph (ring + three dots), with orbiting satellite stones
       * and slow-drawing volutes. Decorative, CSS-only, reduced-motion-safe.
       */}
      <CalcadaBackdrop />

      <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 px-6 py-24 text-center sm:py-32">
        {/* Brand lockup — the same glyph + wordmark used across the app. */}
        <BrandMark size={24} />

        {/* Eyebrow: positions the product before the headline lands. */}
        <span className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {hero.eyebrow}
        </span>

        {/* The headline IS the one-liner. font-display for the brand voice. */}
        <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-6xl">
          {hero.headline}
        </h1>

        {/* Sub-headline: what it means in plain terms. */}
        <p className="max-w-xl text-balance text-lg text-muted-foreground">
          {hero.subhead}
        </p>

        {/*
         * Credibility line: the ETHGlobal Hacker Pack is an on-chain credential
         * (EG-HACKER, balance 1 on Optimism). Understated — no dollar figures.
         * The 🏆 glyph is decorative and stays literal; the copy is localized.
         */}
        <span className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
          <span aria-hidden="true">🏆 </span>
          {hero.hackerPack}
        </span>

        {/* Primary call-to-action: deep-links to /onboard. */}
        <LandingCTA cta={cta} />
      </div>
    </section>
  )
}

export default Hero
