'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

// Client-only: the branding settings view uses Dynamic wallet hooks.
const SettingsBrandingView = dynamic(
  () => import('@/components/pages/SettingsBrandingView').then((m) => m.SettingsBrandingView),
  { ssr: false },
)

export default function SettingsBrandingPage(): ReactNode {
  return <SettingsBrandingView />
}
