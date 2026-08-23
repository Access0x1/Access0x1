'use client'

/**
 * /name — Own your name: buy a real .eth name from the connected wallet.
 *
 * Mounts the merchant/identity wallet stack (MerchantProviders — the same
 * surface as /verify; NOT the customer checkout) and renders the OwnYourName
 * flow. Client-only + ssr:false because the flow is wallet hooks end to end.
 *
 * Fail-soft: with no NEXT_PUBLIC_ENS_REGISTRAR_CONTROLLER configured the flow
 * renders nothing, so this page honestly shows only the free-subname pointer.
 */

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

import { MerchantProviders } from '@/app/MerchantProviders'

const OwnYourName = dynamic(() => import('@/components/OwnYourName'), { ssr: false })

export default function NamePage(): ReactNode {
  return (
    <MerchantProviders>
      <main className="mx-auto max-w-xl px-4 py-10">
        <h1 className="text-xl font-semibold text-ink">Your name, on-chain</h1>
        <p className="mt-2 text-sm opacity-80">
          A name your customers can pay. Claim a free <code>pay.&lt;business&gt;</code> subname during
          onboarding, or own the root itself — a real .eth name, registered from your own wallet,
          never touched by our servers.
        </p>
        <div className="mt-6">
          <OwnYourName />
        </div>
      </main>
    </MerchantProviders>
  )
}
