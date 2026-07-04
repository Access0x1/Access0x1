'use client'

import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import type { ReactNode } from 'react'
import { usePrimaryEnsName } from '@/lib/ens/usePrimaryEnsName'

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
 * PRIMARY-NAME RECOGNITION: when the connected wallet HAS a verified primary ENS
 * name (mainnet, coinType 60 — the identity namespace), we recognize it via
 * {@link usePrimaryEnsName} and render it as the PRIMARY identity line (bold
 * `rensley.eth`), with the email/address demoted to the secondary mono line. The
 * user should see their own name, the way they set it — not a bare 0x. When there
 * is NO primary name (the common case), the chip renders exactly as before.
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
  // Recognize the wallet's own primary name on mainnet. Dormant-safe: with no
  // wallet the hook fetches nothing and returns null.
  const { name: primaryName } = usePrimaryEnsName(primaryWallet?.address)

  if (!primaryWallet) return null

  const address = primaryWallet.address
  // The connector is the source of provenance truth (installed SDK's real API).
  const isEmbedded = primaryWallet.connector?.isEmbeddedWallet ?? false
  const connectorName = primaryWallet.connector?.name ?? 'Wallet'

  // The account identity: email/username when the email/social door was used
  // (the embedded-wallet case), else the truncated address.
  const account = user?.email ?? user?.username ?? short(address)

  return (
    <IdentityChipView
      address={address}
      account={account}
      primaryName={primaryName}
      isEmbedded={isEmbedded}
      connectorName={connectorName}
      onUseOwnWallet={() => setShowAuthFlow(true)}
      onSignOut={() => void handleLogOut()}
    />
  )
}

/**
 * Pure presentational identity panel — no Dynamic context, no hook, no effects.
 * Split out so both states (a recognized primary name vs the email/address
 * default) are deterministically SSR-testable, mirroring MerchantIdentityView.
 *
 * When `primaryName` is a non-empty string it becomes the PRIMARY line (bold),
 * and `account` (email/username/short-address) drops to the secondary mono line
 * alongside the provenance. When it's null, `account` is the primary line exactly
 * as the panel rendered before — no fabricated name is ever shown.
 */
export function IdentityChipView({
  address,
  account,
  primaryName,
  isEmbedded,
  connectorName,
  onUseOwnWallet,
  onSignOut,
}: {
  /** The connected wallet address (the payout/identity address). */
  address: string
  /** Email / username / short-address — the account label. */
  account: string
  /** The verified primary ENS name, or null to show `account` as primary. */
  primaryName: string | null
  /** True for a Dynamic-minted embedded wallet (vs an external EOA). */
  isEmbedded: boolean
  /** Human connector name (e.g. "MetaMask") for the external case. */
  connectorName: string
  /** Open Dynamic's auth/link flow ("use your own wallet instead"). */
  onUseOwnWallet: () => void
  /** Sign the user out. */
  onSignOut: () => void
}): ReactNode {
  const hasPrimaryName = primaryName !== null && primaryName.length > 0
  // The primary (top, bold) line is the recognized ENS name when present, else
  // the account label. The provenance line always names the wallet source.
  const provenance =
    (isEmbedded ? 'Your wallet — created for this account: ' : `Your wallet — ${connectorName}: `) +
    short(address)

  return (
    <div className="flex flex-col items-end gap-1.5" data-primary-name={hasPrimaryName ? 'true' : 'false'}>
      <div className="flex items-center gap-3">
        <div className="flex flex-col items-end gap-0.5 rounded-lg border border-border bg-secondary px-3 py-1.5">
          <span className="max-w-[12rem] truncate text-sm font-medium text-foreground">
            {hasPrimaryName ? primaryName : account}
          </span>
          {/* When a primary name leads, show the account label under it so the
              user still sees which email/wallet this is. */}
          {hasPrimaryName ? (
            <span className="max-w-[12rem] truncate text-xs text-muted-foreground">{account}</span>
          ) : null}
          <span
            className="font-mono text-xs text-muted-foreground"
            title={
              isEmbedded
                ? 'This wallet was created for your account — no seed phrase to manage, and it works everywhere on the Access0x1 rail.'
                : `Connected with ${connectorName}`
            }
          >
            {provenance}
          </span>
        </div>
        <button
          type="button"
          onClick={onSignOut}
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
          onClick={onUseOwnWallet}
          className="text-xs text-rail underline-offset-2 hover:underline"
        >
          Use your own wallet instead
        </button>
      ) : null}
    </div>
  )
}
