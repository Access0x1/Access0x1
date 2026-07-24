'use client'

import { useState, type ReactNode } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { BrandMark } from '@/components/BrandMark'
import { NetworkBadge } from '@/components/NetworkBadge'
import { ConnectButton } from '@/components/ConnectButton'
import { BrandingForm } from '@/components/branding/BrandingForm'
import { CheckoutModeForm } from '@/components/branding/CheckoutModeForm'
import { VerificationLevelsPanel } from '@/components/verification/VerificationLevelsPanel'
import { AskAssistant } from '@/components/AskAssistant'
import { showOnboardCards } from '@/lib/branding/onboardGate'
import { PageHeading } from '@/components/ui/PageHeading'
import { SectionCard } from '@/components/ui/SectionCard'
import { StartFork, type StartPath } from '@/components/onboard/StartFork'
import { DeveloperPanel } from '@/components/onboard/DeveloperPanel'

/**
 * Onboarding view: a "How do you want to start?" fork FIRST (StartFork) → then
 * either the guided, no-jargon "get me paid" flow (OnboardMerchant, ADR D2) or
 * the developer clone/contribute panel (DeveloperPanel). The fork is the first
 * thing a visitor sees, before any sign-in: it asks the only question that
 * changes the path, and never makes a non-technical visitor read wallet jargon
 * to begin.
 *
 * This outer component is just the router — the chosen path is local-only state
 * that never leaves the page. Each path owns its own `<main>` so the layout is
 * identical whichever branch renders.
 *
 * Rendered client-only (the route wrapper imports it with ssr: false) so the
 * Dynamic wallet hooks in the merchant path never run during static generation.
 */
export function OnboardView(): ReactNode {
  const [path, setPath] = useState<StartPath | null>(null)

  if (path === null) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
        <StartFork onChoose={setPath} />
      </main>
    )
  }

  if (path === 'developer') {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
        <DeveloperPanel onBack={() => setPath(null)} />
      </main>
    )
  }

  // path === 'merchant' — the existing guided onboarding, intact.
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
      <OnboardMerchant onDeveloperPath={() => setPath('developer')} />
    </main>
  )
}

/**
 * OnboardMerchant — the guided, no-jargon "get me paid" flow (the existing
 * onboarding, unchanged). Sign in (Dynamic) → three plain-English fields (name,
 * one-line description, logo), a live "Pay {name}" preview, a live checkout-link
 * check, and one Save that yields the checkout link + embed tag + a Test-it
 * button. On-chain registration comes later (the RegisterForm, reachable from
 * the dashboard).
 *
 * Split out as its own component (the JourneyLadder / IdentityChipView
 * precedent) so its wallet-gated behavior — the single hero connect-gate when
 * disconnected vs the three configuration cards when connected — stays directly
 * renderable in the node test env with the Dynamic hook mocked.
 *
 * `onDeveloperPath` is the quiet re-route for someone who reached this flow but
 * actually wants the code, so the fork stays reversible.
 */
export function OnboardMerchant({
  onDeveloperPath,
}: {
  onDeveloperPath: () => void
}): ReactNode {
  // Read inside the MerchantProviders subtree (the route wraps this view in it),
  // so this is safe even when Dynamic is unconfigured: the provider simply never
  // yields a primaryWallet and we render the connect-gate — no hard-throw.
  const { primaryWallet } = useDynamicContext()
  const showCards = showOnboardCards(primaryWallet)

  return (
    <>
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <BrandMark size={18} />
          <PageHeading title="Make it yours" />
        </div>
        {/* SIGNED OUT: render NOTHING here — the hero-gate's one primary "Sign in"
            is the ONLY sign-in (owner: "it should only have 1 sign in"). SIGNED IN:
            the hero gate is gone, so the header carries the IdentityChip + the
            live-network truth chip (which chain the on-chain step will land on). */}
        {primaryWallet ? (
          <div className="flex flex-col items-end gap-2">
            <ConnectButton variant="ghost" />
            <NetworkBadge />
          </div>
        ) : null}
      </header>

      <p className="text-sm text-muted-foreground">
        Access0x1 turns your business into an onchain storefront — a branded checkout link that
        accepts USDC, with no code, no contract, and no gas to manage. Set your name, a one-line
        description, and a logo below to get yours, live in under two minutes.
      </p>

      {showCards ? (
        <>
          <SectionCard>
            <BrandingForm mode="onboard" />
          </SectionCard>

          <SectionCard>
            <p className="mb-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Optional — you can skip this and decide later
            </p>
            <CheckoutModeForm mode="onboard" />
          </SectionCard>

          <section className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Optional — raise your own trust level
            </p>
            <VerificationLevelsPanel />
          </section>

          <p className="text-center text-xs text-muted-foreground">
            Already taking payments and want the on-chain settings? Open your{' '}
            <a href="/dashboard" className="text-rail underline-offset-2 hover:underline">
              dashboard
            </a>
            .
          </p>
        </>
      ) : (
        // DISCONNECTED: one hero connect-gate — a single headline + ONE
        // ConnectButton + a short "what you'll build" line. Not three empty
        // card boxes each repeating a sign-in prompt.
        <SectionCard
          className="flex flex-col items-center gap-5 px-6 py-12 text-center"
          data-onboard-gate="connect"
        >
          <h2 className="font-display text-xl font-semibold text-foreground">
            Sign in to build your checkout
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Connect your wallet and you’ll set your business name, a one-line description, and a logo
            — then get a branded checkout link that accepts USDC. It takes under two minutes.
          </p>
          <ConnectButton />
        </SectionCard>
      )}

      {/* Quiet re-route: a developer who picked this path by mistake can still
          reach the clone/contribute panel — the fork stays reversible. */}
      <p className="text-center text-xs text-muted-foreground">
        Prefer to work with the code?{' '}
        <button
          type="button"
          onClick={onDeveloperPath}
          className="text-rail underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
        >
          See the developer path
        </button>
        .
      </p>

      <AskAssistant />
    </>
  )
}
