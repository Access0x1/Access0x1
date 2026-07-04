'use client'

import type { ReactNode } from 'react'
import { BrandMark } from '@/components/BrandMark'
import { ConnectButton } from '@/components/ConnectButton'
import { CheckoutModeForm } from '@/components/branding/CheckoutModeForm'
import { PageHeading } from '@/components/ui/PageHeading'
import { SectionCard } from '@/components/ui/SectionCard'

/**
 * Settings → Checkout (World ID ADR D0 / D4): the flat hub, sibling to
 * Settings → Branding, holding the one "Who can pay you?" choice. Same layout
 * and "Changes saved" feedback as the branding card — recognize-don't-recall.
 */
export function SettingsCheckoutView(): ReactNode {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <BrandMark size={18} />
          <PageHeading eyebrow="Settings · Checkout" title="Who can pay you" />
        </div>
        <ConnectButton variant="ghost" />
      </header>

      <SectionCard>
        <CheckoutModeForm mode="settings" />
      </SectionCard>

      <a href="/dashboard" className="text-sm text-rail underline-offset-2 hover:underline">
        ← Back to dashboard
      </a>
    </main>
  )
}
