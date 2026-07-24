'use client'

import type { ReactNode } from 'react'
import { BrandMark } from '@/components/BrandMark'
import { ConnectButton } from '@/components/ConnectButton'
import { VerificationLadder } from '@/components/verification/VerificationLadder'
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
        <div className="flex flex-col gap-1">
          <BrandMark size={18} />
          <PageHeading eyebrow="Super Verification" title="Get Super Verified" />
        </div>
        {/* Ghost in the header: when signed out, VerificationLadder owns the ONE
            primary "Sign in" gate below; when signed in this becomes the
            IdentityChip (single-CTA rule). */}
        <ConnectButton variant="ghost" />
      </header>

      <p className="text-sm text-muted-foreground">
        Climb three rungs, one step at a time:{' '}
        <span className="font-medium">○ Connected</span> →{' '}
        <span className="font-medium">✓ Verified</span> →{' '}
        <span className="font-medium text-rail">✓✓ Super Verified</span>. We pick your next step —
        one tap, no menus. Merchants can choose to accept only verified or Super Verified buyers.
      </p>

      <SectionCard>
        <VerificationLadder />
      </SectionCard>

      <a href="/dashboard" className="text-sm text-rail underline-offset-2 hover:underline">
        ← Back to dashboard
      </a>
    </main>
  )
}
