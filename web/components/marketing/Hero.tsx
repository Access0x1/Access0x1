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

import { AnimatedBrandMark } from '@/components/AnimatedBrandMark'
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
       * Moonlight on night water: a low, wide band of cyan lying along the
       * BOTTOM of the fold, where the calçada ground meets the ink — light
       * caught on a surface, which is the brand's own image ("access0x1 across
       * night water"). It replaces a large blurred orb floating above the
       * headline; that shape is the default SaaS halo, it belongs to no
       * particular product, and pinning it behind the h1 washed the one line
       * the page most needs to land. Decorative only — aria-hidden and
       * pointer-events-none, so it never intercepts a click on the CTA. Pure
       * CSS gradient, no image request.
       */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 mx-auto h-20 max-w-4xl rounded-[100%] bg-gradient-to-r from-transparent via-primary/20 to-transparent blur-2xl"
      />

      {/*
       * The calçada layer — Lisbon's hand-set pavement as the hero's ground:
       * a cobbled limestone field and the basalt medallion whose geometry IS
       * the brand glyph (ring + three dots), with orbiting satellite stones
       * and slow-drawing volutes. Decorative, CSS-only, reduced-motion-safe.
       */}
      <CalcadaBackdrop />

      <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 px-6 py-24 text-center sm:py-32">
        {/* Brand lockup — the ANIMATED glyph here, because the hero is the one
            place with room to let the mark say its sentence: power gathers in
            the socket, crosses the connection, the pin lands ON. Everywhere
            else in the app keeps the static {@link BrandMark} — a logo that
            re-animates on every screen is noise, not identity. Motion is
            decorative and no-ops under prefers-reduced-motion. */}
        <AnimatedBrandMark size={56} />

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
