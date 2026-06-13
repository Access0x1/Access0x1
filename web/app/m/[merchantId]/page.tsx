'use client'

import dynamic from 'next/dynamic'
import { use, type ReactNode } from 'react'

// Client-only: the checkout view uses Dynamic wallet hooks + browser context.
const CheckoutView = dynamic(
  () => import('@/components/pages/CheckoutView').then((m) => m.CheckoutView),
  { ssr: false },
)

export default function CheckoutPage({
  params,
}: {
  params: Promise<{ merchantId: string }>
}): ReactNode {
  const { merchantId } = use(params)
  return <CheckoutView merchantIdParam={merchantId} />
}
