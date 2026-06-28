'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { MerchantProviders } from '@/app/MerchantProviders'

// Client-only: the branding settings view uses Dynamic wallet hooks.
const SettingsBrandingView = dynamic(
  () => import('@/components/pages/SettingsBrandingView').then((m) => m.SettingsBrandingView),
  { ssr: false },
)

// Merchant route: wrap in the Dynamic stack (MAU = businesses; Dynamic is scoped
// to merchant surfaces only, never the customer checkout).
export default function SettingsBrandingPage(): ReactNode {
  return (
    <MerchantProviders>
      <SettingsBrandingView />
    </MerchantProviders>
  )
}
