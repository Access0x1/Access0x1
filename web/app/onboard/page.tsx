'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { MerchantProviders } from '@/app/MerchantProviders'

// Client-only: the onboard view uses Dynamic wallet hooks, which cannot run
// during static generation. Importing with ssr: false keeps the build green.
const OnboardView = dynamic(
  () => import('@/components/pages/OnboardView').then((m) => m.OnboardView),
  { ssr: false },
)

// Merchant route: wrap in the Dynamic stack (MAU = businesses; Dynamic is scoped
// to merchant surfaces only, never the customer checkout).
export default function OnboardPage(): ReactNode {
  return (
    <MerchantProviders>
      <OnboardView />
    </MerchantProviders>
  )
}
