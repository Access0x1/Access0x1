'use client'

import type { ReactNode } from 'react'
import { ConnectButton } from '@/components/ConnectButton'
import { CheckoutModeForm } from '@/components/branding/CheckoutModeForm'

/**
 * Settings → Checkout (World ID ADR D0 / D4): the flat hub, sibling to
 * Settings → Branding, holding the one "Who can pay you?" choice. Same layout
 * and "Changes saved" feedback as the branding card — recognize-don't-recall.
 */
export function SettingsCheckoutView(): ReactNode {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-rail">
            Settings · Checkout
          </p>
          <h1 className="text-2xl font-semibold text-ink">Who can pay you</h1>
        </div>
        <ConnectButton />
      </header>

      <section className="rounded-2xl border border-border bg-card p-6">
        <CheckoutModeForm mode="settings" />
      </section>

      <a href="/dashboard" className="text-sm text-rail underline-offset-2 hover:underline">
        ← Back to dashboard
      </a>
    </main>
  )
}
