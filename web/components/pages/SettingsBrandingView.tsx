'use client'

import type { ReactNode } from 'react'
import { ConnectButton } from '@/components/ConnectButton'
import { BrandingForm } from '@/components/branding/BrandingForm'
import { PageHeading } from '@/components/ui/PageHeading'
import { SectionCard } from '@/components/ui/SectionCard'

/**
 * Settings → Branding (ADR D2 "Editing later"): the same three fields — name,
 * description, logo — in a flat card, one click away, "Changes saved" on
 * success. Recognize-don't-recall: identical layout to onboarding, no relearn.
 */
export function SettingsBrandingView(): ReactNode {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
      <header className="flex items-center justify-between">
        <PageHeading eyebrow="Settings · Branding" title="Name, description, logo" />
        <ConnectButton variant="ghost" />
      </header>

      <SectionCard>
        <BrandingForm mode="settings" />
      </SectionCard>

      <a href="/dashboard" className="text-sm text-rail underline-offset-2 hover:underline">
        ← Back to dashboard
      </a>
    </main>
  )
}
