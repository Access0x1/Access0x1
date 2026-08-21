'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

// Client-only: the view fetches the subgraph directly in the browser (no
// server, no secrets). No wallet/provider stack needed — this is a public,
// wallet-free read like /deployments, not a merchant surface.
const NetworkActivityView = dynamic(
  () => import('@/components/pages/NetworkActivityView').then((m) => m.NetworkActivityView),
  { ssr: false },
)

export default function NetworkPage(): ReactNode {
  return <NetworkActivityView />
}
