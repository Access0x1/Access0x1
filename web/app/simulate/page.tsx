'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import type { ReactNode } from 'react'

// Client-only: the simulator reads files in the browser (FileReader) — no
// wallet, no signer, no Dynamic stack. The public RPC work happens server-side
// in /api/onchain-estimate.
const OnChainSvgSimulator = dynamic(
  () => import('@/components/OnChainSvgSimulator').then((m) => m.OnChainSvgSimulator),
  { ssr: false },
)

/**
 * /simulate — the "as if it ran on-chain" studio. Deliberately wallet-free:
 * anyone can upload a mark and get the provable estimate; the connected
 * business meets the same panel again as the last step of /journey.
 */
export default function SimulatePage(): ReactNode {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">On-chain cost simulator</h1>
        <Link href="/journey" className="text-sm text-rail hover:underline">
          The business journey →
        </Link>
      </div>
      <OnChainSvgSimulator />
      <p className="text-xs text-muted-foreground">
        Estimates are computed from published protocol constants (EIP-2028, EIP-7623, EIP-2929/3529,
        EIP-170, EIP-3860) and cross-checked against the selected live testnet. Testnets only.
      </p>
    </main>
  )
}
