'use client'

import dynamic from 'next/dynamic'
import { use, type ReactNode } from 'react'

// Client-only: the slug checkout view uses Dynamic wallet hooks + browser fetch.
const SlugCheckoutView = dynamic(
  () => import('@/components/pages/SlugCheckoutView').then((m) => m.SlugCheckoutView),
  { ssr: false },
)

export default function SlugCheckoutPage({
  params,
}: {
  params: Promise<{ slug: string }>
}): ReactNode {
  const { slug } = use(params)
  return <SlugCheckoutView slug={slug} />
}
