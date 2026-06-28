'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { MerchantProviders } from '@/app/MerchantProviders'

// Client-only: the verification stack uses Dynamic wallet hooks + IDKit.
const VerifyView = dynamic(
  () => import('@/components/pages/VerifyView').then((m) => m.VerifyView),
  { ssr: false },
)

// Super Verification mounts the Dynamic stack: it offers a "signed in via Dynamic"
// verification method and shares the merchant/identity surface (not the customer
// checkout, which is plain wagmi). MAU = businesses; the checkout never mounts this.
export default function VerifyPage(): ReactNode {
  return (
    <MerchantProviders>
      <VerifyView />
    </MerchantProviders>
  )
}
