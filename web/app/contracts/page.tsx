'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { MerchantProviders } from '@/app/MerchantProviders'

// Client-only: the console drives the Dynamic wallet + per-chain RPC reads in the
// browser (no server, no secrets — every read/write runs client-side).
const ContractsView = dynamic(
  () => import('@/components/pages/ContractsView').then((m) => m.ContractsView),
  { ssr: false },
)

/**
 * /contracts — the rail console. Wrapped in the Dynamic stack (MAU = businesses;
 * the same provider the dashboard/onboard surfaces use), because writing to a
 * module needs the merchant wallet. Reads work with just the public RPC.
 */
export default function ContractsPage(): ReactNode {
  return (
    <MerchantProviders>
      <ContractsView />
    </MerchantProviders>
  )
}
