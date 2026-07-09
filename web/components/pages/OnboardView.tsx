'use client'

import type { ReactNode } from 'react'
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

/**
 * Onboarding view: sign in (Dynamic) → the non-coder "Make it yours" branding
 * screen (ADR D2). Three plain-English fields (name, one-line description,
 * logo), a live "Pay {name}" preview, a live checkout-link check, and one Save
 * that yields the checkout link + embed tag + a Test-it button. No code, no
 * deploy, no gas — on-chain registration comes later (the Advanced path, the
 * existing RegisterForm, is reachable from the dashboard).
 *
 * Rendered client-only (the route wrapper imports it with ssr: false) so the
 * Dynamic wallet hooks never run during static generation.
 */
export function OnboardView(): ReactNode {
  // Read inside the MerchantProviders subtree (the route wraps this view in it),
  // so this is safe even when Dynamic is unconfigured: the provider simply never
  // yields a primaryWallet and we render the connect-gate — no hard-throw.
  const { primaryWallet } = useDynamicContext()
  const showCards = showOnboardCards(primaryWallet)

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
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
        Access0x1 turns your business into a crypto-friendly storefront — a branded checkout link that
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

      <AskAssistant />
    </main>
  )
}
