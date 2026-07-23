'use client'

import type { ReactNode } from 'react'

import { BrandMark } from '@/components/BrandMark'
import { PageHeading } from '@/components/ui/PageHeading'
import { SectionCard } from '@/components/ui/SectionCard'
import { OnboardHelpLine } from '@/components/onboard/OnboardHelpLine'

/**
 * The path a visitor picks on the /onboard fork screen:
 *   - 'merchant'  — the guided, no-jargon "get me paid" flow (the existing
 *     branding/register onboarding).
 *   - 'developer' — the clone / contribute panel for people who want the code.
 */
export type StartPath = 'merchant' | 'developer'

/**
 * StartFork — the "How do you want to start?" chooser that FRONTS /onboard.
 *
 * It asks the only thing that actually forks the experience — are you here to
 * get paid, or here to build? — and never makes the non-technical visitor read
 * wallet/contract jargon to answer. Restraint by design: one question headline,
 * one accent (the cyan rail), two tagged cards (one primary CTA + one quieter
 * secondary), and a persistent quiet human-fallback line.
 *
 * PURE + PRESENTATIONAL: it takes an `onChoose` callback and no Dynamic hooks,
 * so the chooser renders (and unit-tests) without a wallet provider — the
 * JourneyLadder / IdentityChipView precedent. The chosen path is owned by
 * OnboardView.
 */
export function StartFork({ onChoose }: { onChoose: (path: StartPath) => void }): ReactNode {
  return (
    <div className="flex flex-col gap-8" data-onboard-fork>
      <header className="flex flex-col gap-2">
        <BrandMark size={18} />
        <PageHeading eyebrow="Get started" title="How do you want to start?" />
        <p className="text-sm text-muted-foreground">
          Two ways in. Pick the one that sounds like you — you can switch either way later.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* PRIMARY — the non-technical, get-me-paid path. Cyan tag + cyan CTA:
            the single accent leads here, where most visitors belong. */}
        <SectionCard className="flex flex-col gap-4" data-fork-card="merchant">
          <span className="w-fit rounded-full bg-rail/10 px-2.5 py-1 text-xs font-medium uppercase tracking-widest text-rail">
            No code
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="font-display text-xl font-semibold text-foreground">Just get me paid</h2>
            <p className="text-sm text-muted-foreground">
              Pick a name, choose where the money lands, and share your link. No wallet jargon, no
              code.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onChoose('merchant')}
            className="mt-auto rounded-lg bg-rail px-4 py-2.5 text-center font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Set up my payments
          </button>
        </SectionCard>

        {/* SECONDARY — the developer path. Neutral tag + outlined CTA so it reads
            as the quieter, second choice (owner: we'd rather they clone). */}
        <SectionCard className="flex flex-col gap-4" data-fork-card="developer">
          <span className="w-fit rounded-full bg-secondary px-2.5 py-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            For developers
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="font-display text-xl font-semibold text-foreground">
              I&apos;m a developer
            </h2>
            <p className="text-sm text-muted-foreground">
              Access0x1 is open source. Clone it and make it yours — or contribute, we&apos;d love
              that.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onChoose('developer')}
            className="mt-auto rounded-lg border border-input px-4 py-2.5 text-center font-medium text-foreground transition-colors hover:border-rail hover:text-rail focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Show me the developer path
          </button>
        </SectionCard>
      </div>

      <OnboardHelpLine />
    </div>
  )
}
