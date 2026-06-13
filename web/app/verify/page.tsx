'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

// Client-only: the verification stack uses Dynamic wallet hooks + IDKit.
const VerifyView = dynamic(
  () => import('@/components/pages/VerifyView').then((m) => m.VerifyView),
  { ssr: false },
)

export default function VerifyPage(): ReactNode {
  return <VerifyView />
}
