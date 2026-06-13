'use client'

import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import type { ReactNode } from 'react'

/** Truncate an EVM address for display: 0x1234…abcd. */
function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

/**
 * Thin wrapper around Dynamic's auth flow. Shows "Connect wallet" when signed
 * out, and the truncated address + "Disconnect" when signed in. All connection
 * goes through Dynamic (`setShowAuthFlow`) — no wagmi `useConnect`.
 */
export function ConnectButton(): ReactNode {
  const { primaryWallet, setShowAuthFlow, handleLogOut } = useDynamicContext()

  if (primaryWallet) {
    return (
      <div className="flex items-center gap-3">
        <span className="rounded-md bg-neutral-100 px-3 py-1.5 font-mono text-sm text-ink">
          {short(primaryWallet.address)}
        </span>
        <button
          type="button"
          onClick={() => void handleLogOut()}
          className="text-sm text-neutral-500 underline-offset-2 hover:underline"
        >
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setShowAuthFlow(true)}
      className="rounded-lg bg-rail px-4 py-2 font-medium text-white transition-opacity hover:opacity-90"
    >
      Connect wallet
    </button>
  )
}
