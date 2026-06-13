'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

// Client-only: the onboard view uses Dynamic wallet hooks, which cannot run
// during static generation. Importing with ssr: false keeps the build green.
const OnboardView = dynamic(
  () => import('@/components/pages/OnboardView').then((m) => m.OnboardView),
  { ssr: false },
)

export default function OnboardPage(): ReactNode {
  return <OnboardView />
}
