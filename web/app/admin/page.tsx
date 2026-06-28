'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { MerchantProviders } from '@/app/MerchantProviders'

/**
 * The owner-admin route (`/admin`). Client-only: the panel reads the connected
 * Dynamic wallet + chain in the browser and signs every owner-gated, on-chain
 * step there (deploy the registry, claim the example repo, anchor a release) — NO
 * keystore, NO server. Dynamic-imported with `ssr:false` so the wallet context
 * never renders on the server (mirrors the dashboard route).
 */
const AdminPanel = dynamic(() => import('./AdminPanel').then((m) => m.AdminPanel), {
  ssr: false,
})

// Merchant/owner route: wrap in the Dynamic stack (MAU = businesses; Dynamic is
// scoped to merchant surfaces only, never the customer checkout).
export default function AdminPage(): ReactNode {
  return (
    <MerchantProviders>
      <AdminPanel />
    </MerchantProviders>
  )
}
