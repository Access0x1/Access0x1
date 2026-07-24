'use client'

import type { ReactNode } from 'react'

import { PageHeading } from '@/components/ui/PageHeading'
import { SectionCard } from '@/components/ui/SectionCard'
import { OnboardHelpLine } from '@/components/onboard/OnboardHelpLine'

/**
 * Canonical public homes for the developer path. The stack is MIT and NOT
 * published to npm, so the honest primary move is clone / degit (see the repo's
 * README + docs/QUICKSTART.md). These are the only two links a developer needs.
 */
const REPO_URL = 'https://github.com/Access0x1/Access0x1'
const QUICKSTART_URL = 'https://github.com/Access0x1/Access0x1/blob/main/docs/QUICKSTART.md'

/**
 * DeveloperPanel — the "I'm a developer" reveal on /onboard.
 *
 * Warm and honest about the stance the repo already takes: the stack is open
 * source and there is no npm package, so the preferred move is clone / degit and
 * make it yours (or contribute). The `@access0x1/react` SDK is offered, but
 * framed as the second choice — clone/contribute first. Two links out (repo +
 * quickstart), the persistent help line, and a way back to the chooser.
 *
 * PURE + PRESENTATIONAL: static copy + links + an `onBack` callback, no hooks —
 * so it renders (and unit-tests) via the server renderer with no provider.
 */
export function DeveloperPanel({ onBack }: { onBack: () => void }): ReactNode {
  return (
    <div className="flex flex-col gap-8" data-onboard-developer>
      <header className="flex flex-col gap-2">
        <PageHeading eyebrow="For developers" title="Build on Access0x1" />
        <p className="text-sm text-muted-foreground">
          Open source, MIT-licensed, testnet-first. Make it yours.
        </p>
      </header>

      <SectionCard className="flex flex-col gap-5">
        <p className="text-sm text-foreground">
          Clone it and make it yours, or contribute — we&apos;d love that. You <em>can</em> use the{' '}
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-ink">
            @access0x1/react
          </code>{' '}
          SDK, but there&apos;s no npm package to install — you clone or degit the repo and wire your
          own env, so we&apos;d rather you clone or contribute.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-rail px-4 py-2.5 text-center font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Clone the repo on GitHub →
          </a>
          <a
            href={QUICKSTART_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-input px-4 py-2.5 text-center font-medium text-foreground transition-colors hover:border-rail hover:text-rail focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Read the Quickstart
          </a>
        </div>
      </SectionCard>

      <button
        type="button"
        onClick={onBack}
        className="w-fit text-sm text-muted-foreground underline-offset-2 hover:text-rail hover:underline focus-visible:text-rail focus-visible:underline focus-visible:outline-none"
      >
        ← Back to start
      </button>

      <OnboardHelpLine />
    </div>
  )
}
