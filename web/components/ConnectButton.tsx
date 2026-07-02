'use client'

import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import type { ReactNode } from 'react'

/** Truncate an EVM address for display: 0x1234…abcd. */
function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

/**
 * Thin wrapper around Dynamic's auth flow. The button says "Sign in" (not "Connect
 * wallet") because the flow is universal: a crypto user picks a wallet, while a
 * non-crypto user continues with email or Google and Dynamic mints an embedded
 * wallet — "Connect wallet" reads as wallet-required and bounces the very users the
 * email/Google door is for. When signed in it shows the user's identity (email or
 * username if the email/Google path was used, else the truncated address) +
 * "Sign out". All connection goes through Dynamic (`setShowAuthFlow`) — no wagmi
 * `useConnect`. (The email/Google sections render once they're enabled on the
 * Dynamic env's dashboard; this component needs no change for that.)
 */
export function ConnectButton(): ReactNode {
  const { primaryWallet, user, setShowAuthFlow, handleLogOut } = useDynamicContext()

  if (primaryWallet) {
    const identity = user?.email ?? user?.username ?? short(primaryWallet.address)
    return (
      <div className="flex items-center gap-3">
        <span className="rounded-md bg-neutral-100 px-3 py-1.5 font-mono text-sm text-ink">
          {identity}
        </span>
        <button
          type="button"
          onClick={() => void handleLogOut()}
          className="text-sm text-neutral-500 underline-offset-2 hover:underline"
        >
          Sign out
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
      Sign in
    </button>
  )
}
