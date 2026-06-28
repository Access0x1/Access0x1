'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { MerchantProviders } from '@/app/MerchantProviders'

// Client-only: the dashboard reads logs + Dynamic wallet context in the browser.
const DashboardView = dynamic(
  () => import('@/components/pages/DashboardView').then((m) => m.DashboardView),
  { ssr: false },
)

// Merchant route: wrap in the Dynamic stack (MAU = businesses; Dynamic is scoped
// to merchant surfaces only, never the customer checkout).
export default function DashboardPage(): ReactNode {
  return (
    <MerchantProviders>
      <DashboardView />
    </MerchantProviders>
  )
}
