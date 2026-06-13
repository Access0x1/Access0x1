'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

// Client-only: the checkout settings view uses Dynamic wallet hooks.
const SettingsCheckoutView = dynamic(
  () => import('@/components/pages/SettingsCheckoutView').then((m) => m.SettingsCheckoutView),
  { ssr: false },
)

export default function SettingsCheckoutPage(): ReactNode {
  return <SettingsCheckoutView />
}
