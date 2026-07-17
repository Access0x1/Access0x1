'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { MerchantProviders } from '@/app/MerchantProviders'

// Client-only: the journey drives the Dynamic wallet through real on-chain
// writes — Dynamic hooks cannot run during static generation.
const JourneyView = dynamic(
  () => import('@/components/pages/JourneyView').then((m) => m.JourneyView),
  { ssr: false },
)

/**
 * /journey — the ordered business lifecycle: connect → register → price a
 * product → bill a customer → reward a customer → share the checkout →
 * simulate the brand mark on-chain. Merchant surface, so it wears the full
 * Dynamic stack (the onboard/dashboard pattern).
 */
export default function JourneyPage(): ReactNode {
  return (
    <MerchantProviders>
      <JourneyView />
    </MerchantProviders>
  )
}
