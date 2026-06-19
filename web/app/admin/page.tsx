'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

/**
 * The owner-admin route (`/admin`). Client-only: the panel reads the connected
 * Dynamic wallet + chain in the browser and signs every owner-gated, on-chain
 * step there (deploy the registry, claim Example's repo, anchor a release) — NO
 * keystore, NO server. Dynamic-imported with `ssr:false` so the wallet context
 * never renders on the server (mirrors the dashboard route).
 */
const AdminPanel = dynamic(() => import('./AdminPanel').then((m) => m.AdminPanel), {
  ssr: false,
})

export default function AdminPage(): ReactNode {
  return <AdminPanel />
}
