'use client'

import { useState, type ReactNode } from 'react'
import { useAccount, useConnect, useDisconnect, type Connector } from 'wagmi'

/** Truncate an EVM address for display: 0x1234…abcd. */
function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

/**
 * The BUYER's wallet connect — plain wagmi, NO Dynamic.
 *
 * MAU model (the core business rule): one Dynamic MAU == one BUSINESS, not one
 * customer. Merchants onboard through Dynamic (`/onboard`, `/dashboard`, …); a
 * customer paying on the hosted checkout must NEVER open a Dynamic session, or
 * every shopper would be metered as an MAU and 1000 MAU would no longer mean
 * 1000 businesses. So the buyer connects with wagmi's own connectors —
 * injected / EIP-6963-discovered browser wallets and WalletConnect — exactly the
 * auth-agnostic path the published `@access0x1/react` SDK uses. The resulting
 * wallet is consumed via the same viem `WalletClient` the rest of checkout
 * already expects (see `lib/contracts.ts#payToken`).
 *
 * UX: one "Connect wallet" button when a single connector is available (the
 * common case — one browser wallet), a compact picker when several are. Once
 * connected it shows the truncated address + "Disconnect", matching the prior
 * Dynamic-backed button so the rest of the checkout layout is unchanged.
 */
export function BuyerConnectButton(): ReactNode {
  const { address, isConnected } = useAccount()
  const { connectors, connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const [pickerOpen, setPickerOpen] = useState(false)

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-3">
        <span className="rounded-md bg-secondary px-3 py-1.5 font-mono text-sm text-ink">
          {short(address)}
        </span>
        <button
          type="button"
          onClick={() => disconnect()}
          className="text-sm text-neutral-500 underline-offset-2 hover:underline"
        >
          Disconnect
        </button>
      </div>
    )
  }

  // De-duplicate connectors by name so EIP-6963 discovery + the static `injected`
  // connector don't surface the same wallet twice (wagmi can list both).
  const seen = new Set<string>()
  const available: Connector[] = connectors.filter((c) => {
    if (seen.has(c.name)) return false
    seen.add(c.name)
    return true
  })

  // Single connector: a one-click "Connect wallet" (no needless picker).
  if (available.length <= 1) {
    const only = available[0]
    return (
      <button
        type="button"
        disabled={isPending || !only}
        onClick={() => only && connect({ connector: only })}
        className="rounded-lg bg-rail px-4 py-2 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    )
  }

  // Several connectors: a compact picker. Opening it lists each wallet by name.
  if (!pickerOpen) {
    return (
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="rounded-lg bg-rail px-4 py-2 font-medium text-white transition-opacity hover:opacity-90"
      >
        Connect wallet
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {available.map((connector) => (
        <button
          key={connector.uid}
          type="button"
          disabled={isPending}
          onClick={() => connect({ connector })}
          className="rounded-lg border border-rail px-4 py-2 text-left font-medium text-rail transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {connector.name}
        </button>
      ))}
    </div>
  )
}
