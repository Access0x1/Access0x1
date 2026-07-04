'use client'

import type { ReactNode } from 'react'
import { ConnectButton } from '@/components/ConnectButton'
import { VerificationStack } from '@/components/verification/VerificationStack'
import { PageHeading } from '@/components/ui/PageHeading'
import { SectionCard } from '@/components/ui/SectionCard'

/**
 * /verify — the Super Verification page. One panel: every way to verify, what
 * each adds, the badge earned, and the nudge to climb to Super Verified. The
 * more you verify, the higher your trust tier — which merchants can require at
 * checkout ("Super Verified buyers only").
 */
export function VerifyView(): ReactNode {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
      <header className="flex items-center justify-between">
        <PageHeading eyebrow="Super Verification" title="Get Super Verified" />
        {/* Ghost in the header: when signed out, VerificationStack owns the ONE
            primary "Sign in" gate below; when signed in this becomes the
            IdentityChip (single-CTA rule). */}
        <ConnectButton variant="ghost" />
      </header>

      <p className="text-sm text-muted-foreground">
        There are many ways to prove you&apos;re real. Each one you add raises your trust — verify
        enough and you become <span className="font-medium text-rail">Super Verified</span>, the
        highest tier. Merchants can choose to accept only verified or Super Verified buyers.
      </p>

      <SectionCard>
        <VerificationStack />
      </SectionCard>

      <a href="/dashboard" className="text-sm text-rail underline-offset-2 hover:underline">
        ← Back to dashboard
      </a>
    </main>
  )
}
