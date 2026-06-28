'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { MerchantProviders } from '@/app/MerchantProviders'

// Client-only: the checkout settings view uses Dynamic wallet hooks.
const SettingsCheckoutView = dynamic(
  () => import('@/components/pages/SettingsCheckoutView').then((m) => m.SettingsCheckoutView),
  { ssr: false },
)

// Merchant route: wrap in the Dynamic stack (MAU = businesses; Dynamic is scoped
// to merchant surfaces only, never the customer checkout).
export default function SettingsCheckoutPage(): ReactNode {
  return (
    <MerchantProviders>
      <SettingsCheckoutView />
    </MerchantProviders>
  )
}
