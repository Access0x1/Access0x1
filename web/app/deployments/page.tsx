'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

// Client-only: the view reads on-chain code from each chain's RPC in the browser
// (no server, no secrets — every `getCode` call runs client-side).
const DeploymentsView = dynamic(
  () => import('@/components/pages/DeploymentsView').then((m) => m.DeploymentsView),
  { ssr: false },
)

export default function DeploymentsPage(): ReactNode {
  return <DeploymentsView />
}
