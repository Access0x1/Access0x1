'use client'

import { useState, type ReactNode } from 'react'
import type { Chain } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getWalletClient } from '@/lib/wallet'
import { ensureChain, isTestnetChain, useLiveChain, writableChains, type LiveChain } from '@/lib/live-chain'

/**
 * NetworkBadge — the live-network truth chip for merchant surfaces.
 *
 * Shows WHERE the wallet actually is right now (the live chain name + a
 * TESTNET/MAINNET tag read off the viem chain object), re-rendering on chain
 * and account switches via {@link useLiveChain} — no refresh. When the wallet
 * sits on a network no merchant write can land on, the badge says so honestly
 * and offers one inline switch button per writable chain, using the AdminPanel
 * `prepareWallet` pattern generalized as {@link ensureChain}.
 *
 * Renders nothing when no wallet is connected — the surfaces already show
 * their own connect gates, and there is no live network to be truthful about.
 */
export function NetworkBadge({ className }: { className?: string }): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const live = useLiveChain()
  // The chain id a switch is currently in flight for (disables that button).
  const [switching, setSwitching] = useState<number | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  if (!live.isConnected) return null

  async function handleSwitch(targetChainId: number): Promise<void> {
    setSwitchError(null)
    setSwitching(targetChainId)
    try {
      const walletClient = await getWalletClient(primaryWallet)
      await ensureChain(walletClient, targetChainId)
      // No state to set on success — the wagmi store hears chainChanged and
      // useLiveChain re-renders this badge on the new chain by itself.
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : 'Could not switch network.')
    } finally {
      setSwitching(null)
    }
  }

  return (
    <NetworkBadgeView
      live={live}
      targets={writableChains()}
      switching={switching}
      switchError={switchError}
      onSwitch={(id) => void handleSwitch(id)}
      className={className}
    />
  )
}

/**
 * Pure presentational badge — no wagmi, no Dynamic, no effects — so every
 * state is deterministically SSR-testable (the IdentityChipView precedent).
 *
 * Three states, tagged via `data-network-badge` for tests:
 *   - "supported"   — the live chain takes merchant writes; green dot + name + tag.
 *   - "no-router"   — a known app chain with no router deployed/configured.
 *   - "unsupported" — a network the app doesn't know at all.
 * The two bad states carry the inline per-chain switch buttons.
 */
export function NetworkBadgeView({
  live,
  targets,
  switching,
  switchError,
  onSwitch,
  className,
}: {
  /** The resolved live-chain state to render. */
  live: LiveChain
  /** The writable chains offered as switch targets. */
  targets: readonly Chain[]
  /** The chain id a switch is in flight for (disables its button), or null. */
  switching: number | null
  /** The last switch failure to surface inline, or null. */
  switchError: string | null
  /** Ask the wallet to switch to this chain id. */
  onSwitch: (chainId: number) => void
  className?: string
}): ReactNode {
  // The TESTNET/MAINNET tag is only claimed when the chain is KNOWN — we never
  // guess the flavor of a network we can't identify (law #4).
  const tag = live.chain ? (isTestnetChain(live.chain) ? 'TESTNET' : 'MAINNET') : null

  if (live.isSupported && live.chain) {
    return (
      <span
        data-network-badge="supported"
        className={`inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground ${className ?? ''}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden />
        {live.chain.name}
        {tag ? <span className="text-[10px] font-semibold tracking-wider text-muted-foreground">{tag}</span> : null}
      </span>
    )
  }

  const state = live.chain ? 'no-router' : 'unsupported'
  const headline = live.chain
    ? `${live.chain.name} — no payments router on this network`
    : `Unsupported network${live.chainId !== null ? ` (chain ${live.chainId})` : ''}`

  return (
    <div
      data-network-badge={state}
      className={`flex w-fit flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 ${className ?? ''}`}
    >
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
        {headline}
        {tag ? <span className="text-[10px] font-semibold tracking-wider">{tag}</span> : null}
      </span>
      {targets.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5">
          {targets.map((chain) => (
            <button
              key={chain.id}
              type="button"
              onClick={() => onSwitch(chain.id)}
              disabled={switching !== null}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground transition-colors hover:border-rail hover:text-rail disabled:cursor-not-allowed disabled:opacity-50"
            >
              {switching === chain.id ? 'Switching…' : `Switch to ${chain.name}`}
            </button>
          ))}
        </span>
      ) : null}
      {switchError ? <span className="text-xs text-red-600">{switchError}</span> : null}
    </div>
  )
}
