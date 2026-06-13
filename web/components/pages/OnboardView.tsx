'use client'

import type { ReactNode } from 'react'
import { ConnectButton } from '@/components/ConnectButton'
import { BrandingForm } from '@/components/branding/BrandingForm'
import { AskAssistant } from '@/components/AskAssistant'

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
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-rail">Access0x1</p>
          <h1 className="text-2xl font-semibold text-ink">Make it yours</h1>
        </div>
        <ConnectButton />
      </header>

      <p className="text-sm text-neutral-500">
        Set your name, a one-line description, and a logo. You&apos;ll get a branded checkout link
        and an embed tag — live in under two minutes, no code and no gas.
      </p>

      <section className="rounded-2xl border border-neutral-200 p-6">
        <BrandingForm mode="onboard" />
      </section>

      <p className="text-center text-xs text-neutral-400">
        Already taking payments and want the on-chain settings? Open your{' '}
        <a href="/dashboard" className="text-rail underline-offset-2 hover:underline">
          dashboard
        </a>
        .
      </p>

      <AskAssistant />
    </main>
  )
}
