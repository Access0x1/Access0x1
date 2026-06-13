'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

// Client-only: the dashboard reads logs + Dynamic wallet context in the browser.
const DashboardView = dynamic(
  () => import('@/components/pages/DashboardView').then((m) => m.DashboardView),
  { ssr: false },
)

export default function DashboardPage(): ReactNode {
  return <DashboardView />
}
