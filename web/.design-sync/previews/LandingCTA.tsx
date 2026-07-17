import { LandingCTA } from '@access0x1/web'

// Server-renderable, zero-required-props CTA row (primary "Get started" +
// ghost "Ask how it works"). Real call sites are either bare (Hero.tsx) or
// composed inside a closing section with a heading + paragraph and a top
// margin (app/page.tsx) — both are real usage, not invented content.

// Hero.tsx: <LandingCTA />
export const Bare = () => <LandingCTA />

// app/page.tsx's closing call-to-action section, verbatim copy.
export const InClosingSection = () => (
  <section className="mx-auto w-full max-w-3xl px-6 pb-8 pt-8 text-center">
    <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
      Get onchain in under two minutes
    </h2>
    <p className="mx-auto mt-3 max-w-lg text-balance text-muted-foreground">
      No code, no contract to deploy, no gas to manage. Set your name, share your link, get paid in
      USDC.
    </p>
    <LandingCTA className="mt-8" />
  </section>
)
