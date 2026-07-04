'use client'

import type { ReactNode } from 'react'
import { ConnectButton } from '@/components/ConnectButton'
import { BrandingForm } from '@/components/branding/BrandingForm'

/**
 * Settings → Branding (ADR D2 "Editing later"): the same three fields — name,
 * description, logo — in a flat card, one click away, "Changes saved" on
 * success. Recognize-don't-recall: identical layout to onboarding, no relearn.
 */
export function SettingsBrandingView(): ReactNode {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-rail">
            Settings · Branding
          </p>
          <h1 className="text-2xl font-semibold text-ink">Name, description, logo</h1>
        </div>
        <ConnectButton />
      </header>

      <section className="rounded-2xl border border-border bg-card p-6">
        <BrandingForm mode="settings" />
      </section>

      <a href="/dashboard" className="text-sm text-rail underline-offset-2 hover:underline">
        ← Back to dashboard
      </a>
    </main>
  )
}
