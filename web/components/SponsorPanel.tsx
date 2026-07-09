'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { Address, Hash } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getChain, getDefaultChainId, getRouterAddress } from '@/lib/chains'
import { ensureChain, useLiveChain } from '@/lib/live-chain'
import { getPublicClient, getWalletAddress, getWalletClient } from '@/lib/wallet'
import { getMerchant } from '@/lib/contracts'
import {
  readSponsorState,
  writeSponsorRegistry,
  type SponsorRegistryWrite,
  type SponsorState,
} from '@/lib/sponsor-registry'
import { TxHashLink } from '@/components/TxHashLink'
import { SectionCard } from '@/components/ui/SectionCard'

/**
 * The panel's five actions. `decline`, `withdraw` and `clear` all submit
 * `clearSponsor` on-chain — the split exists so each role sees its own verb
 * and busy label (the contract itself has exactly three writes).
 */
export type SponsorAction = 'offer' | 'accept' | 'decline' | 'withdraw' | 'clear'

const ACTION_TO_WRITE: Record<SponsorAction, SponsorRegistryWrite> = {
  offer: 'offerSponsorship',
  accept: 'acceptSponsor',
  decline: 'clearSponsor',
  withdraw: 'clearSponsor',
  clear: 'clearSponsor',
}

/** Who the connected wallet IS relative to this merchant seat's sponsor record. */
export interface SponsorRole {
  /** A wallet is connected at all. */
  connected: boolean
  /** The wallet is the merchant seat's LIVE owner (from `merchants(id)`). */
  isOwner: boolean
  /** The wallet is the pending (offered, unaccepted) sponsor. */
  isPendingSponsor: boolean
  /** The wallet is the RECORDED (accepted) sponsor. */
  isSponsor: boolean
}

/** Truncate an address for display: 0x1234…abcd. */
function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Case-insensitive address equality (checksum-safe). */
function sameAddress(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
}

/**
 * SponsorPanel — the dashboard surface where a business sees whether its gas
 * sponsor is CONNECTED or NOT-YET-WIRED, and wires it.
 *
 * The record is the Access0x1SponsorRegistry (record-only v1 — it gates no
 * money path; gasless settlement stays any-relayer). The registry's CREATE3
 * mirror address is computed but DEPLOYED NOWHERE yet, so the panel's default
 * truthful state on every chain today is "not on this chain yet" — it must
 * never fake a green.
 *
 * Chain resolution follows the DashboardView it mounts under: the WALLET'S
 * live chain when supported, else the app default — so the sponsor record the
 * panel shows and the receipts feed above it always read the SAME chain.
 * Every write pins the wallet to that chain first ({@link ensureChain}).
 */
export function SponsorPanel({ merchantId }: { merchantId: bigint }): ReactNode {
  const live = useLiveChain()
  const chainId = live.isSupported && live.chainId !== null ? live.chainId : getDefaultChainId()
  const { primaryWallet } = useDynamicContext()
  const walletAddress = getWalletAddress(primaryWallet)

  const [state, setState] = useState<SponsorState | null>(null)
  // True when the LAST refresh couldn't reach the chain while we still show an
  // earlier good state (fail-soft: keep the last good state, say it's stale).
  const [stale, setStale] = useState(false)
  const [ownerAddress, setOwnerAddress] = useState<Address | null>(null)
  const [busy, setBusy] = useState<SponsorAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<Hash | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // A different chain (or merchant) is a DIFFERENT record — drop the old state
  // entirely so a last-good snapshot from chain A never renders as chain B's.
  useEffect(() => {
    setState(null)
    setStale(false)
    setOwnerAddress(null)
    setError(null)
    setTxHash(null)
  }, [chainId, merchantId])

  // Load the sponsor record (+ the seat owner for role gating) fail-soft.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const client = getPublicClient(chainId)
      const next = await readSponsorState(client, chainId, merchantId)
      if (cancelled) return
      if (next.deployed === null) {
        // Unreachable: keep the last GOOD state if we have one, flag it stale;
        // with nothing to keep, show the distinct unknown card.
        setStale(true)
        setState((prev) => (prev !== null && prev.deployed !== null ? prev : next))
        return
      }
      setStale(false)
      setState(next)
      if (next.deployed) {
        // Role gating needs the seat's LIVE owner. Fail-soft to null: an
        // unknown owner only hides owner-gated buttons (the contract still
        // enforces ownership on-chain).
        try {
          const merchant = await getMerchant(client, getRouterAddress(chainId), merchantId)
          if (!cancelled) setOwnerAddress(merchant.owner)
        } catch {
          if (!cancelled) setOwnerAddress(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chainId, merchantId, reloadKey])

  const role: SponsorRole = {
    connected: walletAddress !== null,
    isOwner: sameAddress(walletAddress, ownerAddress),
    isPendingSponsor: sameAddress(walletAddress, state?.pending ?? null),
    isSponsor: sameAddress(walletAddress, state?.sponsor ?? null),
  }

  async function run(action: SponsorAction): Promise<void> {
    setError(null)
    setTxHash(null)
    setBusy(action)
    try {
      let walletClient = await getWalletClient(primaryWallet)
      // Pin the wallet to the panel's chain BEFORE the write (never a
      // wrong-chain tx); after a switch, re-derive the client so its chain
      // snapshot matches the chain the tx submits on.
      const switched = await ensureChain(walletClient, chainId)
      if (switched) walletClient = await getWalletClient(primaryWallet)
      const publicClient = getPublicClient(chainId)
      const { txHash } = await writeSponsorRegistry(
        walletClient,
        publicClient,
        chainId,
        merchantId,
        ACTION_TO_WRITE[action],
      )
      setTxHash(txHash)
      // Re-read the record — the receipt landed, show the on-chain truth.
      setReloadKey((k) => k + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <SponsorPanelView
      chainId={chainId}
      chainName={getChain(chainId).name}
      merchantId={merchantId.toString()}
      state={state}
      stale={stale}
      role={role}
      busy={busy}
      error={error}
      txHash={txHash}
      onAction={(action) => void run(action)}
      onRetry={() => {
        setError(null)
        setReloadKey((k) => k + 1)
      }}
    />
  )
}

/** One panel action button (shared styling + busy label). */
function ActionButton({
  action,
  label,
  busyLabel,
  busy,
  onAction,
  tone = 'neutral',
}: {
  action: SponsorAction
  label: string
  busyLabel: string
  busy: SponsorAction | null
  onAction: (action: SponsorAction) => void
  tone?: 'primary' | 'neutral'
}): ReactNode {
  const toneClass =
    tone === 'primary'
      ? 'bg-rail text-white hover:opacity-90'
      : 'border border-input bg-background text-foreground hover:border-rail hover:text-rail'
  return (
    <button
      type="button"
      onClick={() => onAction(action)}
      disabled={busy !== null}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      {busy === action ? busyLabel : label}
    </button>
  )
}

/**
 * Pure presentational panel — no wagmi, no Dynamic, no effects — so every
 * state renders deterministically under React's static server renderer (the
 * NetworkBadgeView precedent).
 *
 * Five states, tagged via `data-sponsor-panel` for tests:
 *   - "not-deployed" — no code at the registry address on this chain (the
 *     truthful default everywhere until the module lands). Muted, no buttons.
 *   - "unknown"      — the chain couldn't be reached and there is no last good
 *     state. Retry only — never conflated with "not deployed".
 *   - "none"         — registry live, no sponsor and no offer: FLAGGED as an
 *     outstanding action (warn accent). Non-owners can offer.
 *   - "pending"      — an offer awaits the owner (accept/decline); the pending
 *     sponsor can withdraw it.
 *   - "connected"    — `sponsorOf` is set (THE record): green, clear available
 *     to the owner or the sponsor.
 */
export function SponsorPanelView({
  chainId,
  chainName,
  merchantId,
  state,
  stale,
  role,
  busy,
  error,
  txHash,
  onAction,
  onRetry,
}: {
  /** The chain the panel reads/writes (for the explorer link). */
  chainId: number
  /** Human name of that chain (for the honest per-chain copy). */
  chainName: string
  /** The bound merchant id, as a string. */
  merchantId: string
  /** The sponsor record to render, or null while first loading. */
  state: SponsorState | null
  /** True when showing a last-good state that just failed to refresh. */
  stale: boolean
  /** The connected wallet's relationship to this seat. */
  role: SponsorRole
  /** The action currently in flight (disables all buttons), or null. */
  busy: SponsorAction | null
  /** The last write failure to surface honestly, or null. */
  error: string | null
  /** The last successful write's tx hash, or null. */
  txHash: string | null
  /** Submit an action. */
  onAction: (action: SponsorAction) => void
  /** Re-read the record after an unreachable refresh. */
  onRetry: () => void
}): ReactNode {
  const heading = (
    <div>
      <h2 className="text-lg font-semibold text-ink">Gas sponsor</h2>
      <p className="text-xs text-muted-foreground">
        An on-chain record of who covers gas for merchant #{merchantId} — it never gates
        settlement.
      </p>
    </div>
  )

  // First load: a quiet skeleton, no status claim yet.
  if (state === null) {
    return (
      <SectionCard data-sponsor-panel="loading" className="flex flex-col gap-3">
        {heading}
        <div className="h-10 animate-pulse rounded-lg bg-secondary" />
      </SectionCard>
    )
  }

  // UNKNOWN — the chain couldn't be reached and there's no last good state.
  if (state.deployed === null) {
    return (
      <SectionCard data-sponsor-panel="unknown" className="flex flex-col gap-3">
        {heading}
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t reach {chainName} to check the sponsor status — retry.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-secondary"
        >
          Retry
        </button>
      </SectionCard>
    )
  }

  // REGISTRY NOT ON THIS CHAIN — the honest default until the module lands.
  if (state.deployed === false) {
    return (
      <SectionCard data-sponsor-panel="not-deployed" className="flex flex-col gap-2 bg-secondary/50">
        {heading}
        <p className="text-sm text-muted-foreground">
          The sponsor registry isn&apos;t deployed on {chainName} yet — gasless sponsorship
          arrives when it lands.
        </p>
      </SectionCard>
    )
  }

  // The refresh-failed notice shown on top of a kept last-good state.
  const staleNotice = stale ? (
    <p className="flex items-center gap-2 text-xs text-amber-600" data-testid="sponsor-stale">
      Couldn&apos;t refresh just now — showing the last known status.
      <button type="button" onClick={onRetry} className="underline underline-offset-2">
        Retry
      </button>
    </p>
  ) : null

  const feedback = (
    <>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {txHash ? (
        <p className="text-xs text-muted-foreground">
          Submitted: <TxHashLink chainId={chainId} hash={txHash} />
        </p>
      ) : null}
    </>
  )

  // A pending offer (shown standalone, or under a connected record — the
  // contract lets any wallet offer at any time; the record stays the record).
  const pendingBlock =
    state.pending !== null ? (
      <div className="flex flex-col gap-2" data-testid="sponsor-pending-offer">
        <p className="text-sm text-ink">
          Sponsorship offer from <span className="font-mono text-xs">{short(state.pending)}</span>
          {role.isPendingSponsor ? ' (you)' : ''} — awaiting the owner&apos;s acceptance.
        </p>
        <span className="flex flex-wrap gap-2">
          {role.isOwner ? (
            <>
              <ActionButton
                action="accept"
                label="Accept sponsor"
                busyLabel="Accepting…"
                busy={busy}
                onAction={onAction}
                tone="primary"
              />
              <ActionButton
                action="decline"
                label="Decline offer"
                busyLabel="Declining…"
                busy={busy}
                onAction={onAction}
              />
            </>
          ) : null}
          {role.isPendingSponsor ? (
            <ActionButton
              action="withdraw"
              label="Withdraw offer"
              busyLabel="Withdrawing…"
              busy={busy}
              onAction={onAction}
            />
          ) : null}
        </span>
      </div>
    ) : null

  // CONNECTED — sponsorOf is non-zero: THE record.
  if (state.sponsor !== null) {
    return (
      <SectionCard
        data-sponsor-panel="connected"
        className="flex flex-col gap-3 border-green-200 bg-green-50/40"
      >
        {heading}
        {staleNotice}
        <p className="text-sm font-medium text-green-700">
          ✓ Gas sponsor connected:{' '}
          <span className="font-mono text-xs">{short(state.sponsor)}</span>
          {role.isSponsor ? ' (you)' : ''}
        </p>
        {role.isOwner || role.isSponsor ? (
          <span className="flex flex-wrap gap-2">
            <ActionButton
              action="clear"
              label="Clear sponsor"
              busyLabel="Clearing…"
              busy={busy}
              onAction={onAction}
            />
          </span>
        ) : null}
        {pendingBlock ? (
          <div className="border-t border-green-200 pt-3">{pendingBlock}</div>
        ) : null}
        {feedback}
      </SectionCard>
    )
  }

  // OFFER PENDING — no accepted sponsor yet, an offer awaits.
  if (state.pending !== null) {
    return (
      <SectionCard data-sponsor-panel="pending" className="flex flex-col gap-3 border-rail/30 bg-rail/5">
        {heading}
        {staleNotice}
        {pendingBlock}
        {feedback}
      </SectionCard>
    )
  }

  // NOT-YET-WIRED — registry live here, nothing recorded: the outstanding action.
  return (
    <SectionCard
      data-sponsor-panel="none"
      className="flex flex-col gap-3 border-amber-500/40 bg-amber-500/10"
    >
      {heading}
      {staleNotice}
      <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
        No gas sponsor wired.
      </p>
      <p className="text-sm text-muted-foreground">
        Share your merchant id (#{merchantId}) with a sponsor, or have them connect here and
        offer.
      </p>
      {role.connected && !role.isOwner ? (
        <span className="flex flex-wrap gap-2">
          <ActionButton
            action="offer"
            label="Offer to sponsor this business"
            busyLabel="Offering…"
            busy={busy}
            onAction={onAction}
            tone="primary"
          />
        </span>
      ) : null}
      {feedback}
    </SectionCard>
  )
}
