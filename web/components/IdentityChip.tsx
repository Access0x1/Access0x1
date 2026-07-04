'use client'

import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import type { ReactNode } from 'react'

/** Truncate an EVM address for display: 0x1234…abcd. */
function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

/**
 * IdentityChip — the signed-in identity + wallet PROVENANCE panel.
 *
 * The old signed-in view showed only email/username/address + "Sign out", never
 * saying WHERE the wallet came from. That matters here: a non-crypto merchant who
 * signed in with email got an embedded wallet minted for them by Dynamic, and
 * they should be told "this is your wallet, created for this account — no seed
 * phrase, works everywhere on the rail", not shown a bare 0x address they don't
 * recognize. A crypto merchant who connected MetaMask should see that named.
 *
 * Provenance is read from the INSTALLED SDK's real connector API
 * (@dynamic-labs/sdk-react-core 4.88): `primaryWallet.connector.isEmbeddedWallet`
 * (boolean) distinguishes the Dynamic-minted embedded wallet from an external
 * EOA, and `primaryWallet.connector.name` is the human connector name
 * (e.g. "MetaMask"). We render exactly ONE provenance line:
 *   - embedded → "Your wallet — created for this account: 0x…" (+ the reassuring
 *     "no seed phrase needed" line), and a secondary "Use your own wallet
 *     instead" that opens Dynamic's auth/link flow (`setShowAuthFlow(true)`).
 *   - external → "Your wallet — <ConnectorName>: 0x…" (they chose it; no extra
 *     action).
 * Plus "Sign out". All flows go through Dynamic — no wagmi here (merchant surface).
 */
export function IdentityChip(): ReactNode {
  const { primaryWallet, user, setShowAuthFlow, handleLogOut } = useDynamicContext()

  if (!primaryWallet) return null

  const address = primaryWallet.address
  // The connector is the source of provenance truth (installed SDK's real API).
  const isEmbedded = primaryWallet.connector?.isEmbeddedWallet ?? false
  const connectorName = primaryWallet.connector?.name ?? 'Wallet'

  // The account identity: email/username when the email/social door was used
  // (the embedded-wallet case), else the truncated address.
  const identity = user?.email ?? user?.username ?? short(address)

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-3">
        <div className="flex flex-col items-end gap-0.5 rounded-lg border border-border bg-secondary px-3 py-1.5">
          <span className="max-w-[12rem] truncate text-sm font-medium text-foreground">
            {identity}
          </span>
          <span
            className="font-mono text-xs text-muted-foreground"
            title={
              isEmbedded
                ? 'This wallet was created for your account — no seed phrase to manage, and it works everywhere on the Access0x1 rail.'
                : `Connected with ${connectorName}`
            }
          >
            {isEmbedded ? 'Your wallet — created for this account: ' : `Your wallet — ${connectorName}: `}
            {short(address)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void handleLogOut()}
          className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Sign out
        </button>
      </div>

      {isEmbedded ? (
        // Embedded users chose the easy door; offer the OTHER path once, quietly.
        // Wallet users already picked their wallet, so they get nothing extra.
        <button
          type="button"
          onClick={() => setShowAuthFlow(true)}
          className="text-xs text-rail underline-offset-2 hover:underline"
        >
          Use your own wallet instead
        </button>
      ) : null}
    </div>
  )
}
