'use client'

import { useState, type FormEvent, type ReactNode } from 'react'
import { isAddress, keccak256, toHex, type Address, type Hash } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getDefaultChainId } from '@/lib/chains'
import { ensureChain, useLiveChain } from '@/lib/live-chain'
import { NetworkBadge } from '@/components/NetworkBadge'
import { registerMerchant } from '@/lib/contracts'
import { getPublicClient, getWalletClient } from '@/lib/wallet'
import { EnsResolutionError, isEnsInput, resolveENS } from '@/lib/ens'
import { setWalletLabel } from '@/lib/walletLabel'

export interface RegisterResult {
  merchantId: bigint
  txHash: Hash
  name: string
  priceUsd: string
  chainId: number
}

/**
 * Onboarding form: business name + USD price (+ optional fee recipient) ->
 * `registerMerchant(payout = connected address, feeRecipient, feeBps = 0,
 * nameHash = keccak256(name))`. On success it hands the result up to the page,
 * which renders the link/QR/snippet card. The typed name is stored client-side
 * (the on-chain record holds only the nameHash commitment).
 *
 * LIVE-CHAIN AWARE: the router resolves from the WALLET'S live chain
 * ({@link useLiveChain}) — never the build-time default — and
 * {@link ensureChain} pins the wallet to that same chain before the write, so
 * the address shown, the chain signed, and the router written to can never
 * diverge. On an unsupported network the submit is disabled with an honest
 * message and the NetworkBadge offers the switch.
 */
export function RegisterForm({
  onRegistered,
}: {
  onRegistered: (result: RegisterResult) => void
}): ReactNode {
  const { primaryWallet, setShowAuthFlow } = useDynamicContext()
  // The wallet's LIVE chain — re-renders on chain/account switch (wagmi store).
  const live = useLiveChain()
  const [name, setName] = useState('')
  const [priceUsd, setPriceUsd] = useState('29.00')
  const [feeRecipient, setFeeRecipient] = useState('')
  /**
   * When the user types an ENS name in the fee-recipient field we resolve it
   * on the fly (on blur + on submit) so they can see the resolved address before
   * committing. Three sub-states:
   *   resolvedFeeRecipient — the 0x address the ENS name resolved to (or null
   *     when the field is empty / is already a 0x address / resolution failed).
   *   ensResolving — true while a resolution network call is in-flight.
   *   ensError — the human-readable failure message (resolution failure only;
   *     general form errors go in `error`).
   */
  const [resolvedFeeRecipient, setResolvedFeeRecipient] = useState<Address | null>(null)
  const [ensResolving, setEnsResolving] = useState(false)
  const [ensError, setEnsError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Attempt to resolve the fee-recipient field when it looks like an ENS name.
   * Called on blur and at the top of handleSubmit.  Always clears the previous
   * resolution state first so stale values are never used silently.
   *
   * Returns the resolved address on success, or null when the field is empty /
   * is already a 0x address (no resolution needed) or resolution failed (the
   * ensError state holds the user-facing message).
   */
  async function resolveFeeRecipientENS(): Promise<Address | null> {
    const trimmed = feeRecipient.trim()
    setResolvedFeeRecipient(null)
    setEnsError(null)

    // Empty or already a valid 0x address — no resolution needed.
    if (!trimmed || isAddress(trimmed)) return null

    if (isEnsInput(trimmed)) {
      setEnsResolving(true)
      try {
        // Resolve for the chain the registration will actually land on — the
        // wallet's live chain — falling back to the app default pre-connect.
        const chainId = live.chainId ?? getDefaultChainId()
        const addr = await resolveENS(trimmed, chainId)
        setResolvedFeeRecipient(addr)
        return addr
      } catch (err) {
        const message =
          err instanceof EnsResolutionError
            ? `Could not resolve "${trimmed}" — make sure the name is correct and has an address set for this chain.`
            : err instanceof Error
              ? `ENS resolution failed: ${err.message}`
              : 'ENS resolution failed.'
        setEnsError(message)
        return null
      } finally {
        setEnsResolving(false)
      }
    }

    // Input has a dot but is not a valid address and resolveENS would reject it
    // anyway — let handleSubmit surface the validation error.
    return null
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)

    if (!primaryWallet) {
      setError('Connect a wallet first.')
      return
    }
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Enter a business name.')
      return
    }
    const price = Number(priceUsd)
    if (!Number.isFinite(price) || price <= 0) {
      setError('Enter a valid USD price greater than 0.')
      return
    }

    // Resolve the fee-recipient: plain 0x passes straight through; an ENS name
    // is resolved to a 0x address right here.  If resolution is already cached
    // from the onBlur handler we skip the network call.
    const trimmedFeeRecipient = feeRecipient.trim()
    let resolvedAddr: Address | null = resolvedFeeRecipient

    if (trimmedFeeRecipient && !isAddress(trimmedFeeRecipient)) {
      if (!resolvedAddr) {
        // Either the user skipped blur or the cached value is stale — try once more.
        resolvedAddr = await resolveFeeRecipientENS()
      }
      if (!resolvedAddr) {
        // ENS resolution failed; ensError was set by resolveFeeRecipientENS.
        if (!ensError) {
          setError('Fee recipient must be a valid 0x address or a resolvable ENS name.')
        }
        return
      }
    }

    // THE LIVE-CHAIN GUARD: the router comes from the wallet's ACTUAL chain
    // (never the build-time default), and both are captured from the SAME
    // LiveChain snapshot — so the write below can only ever target the router
    // that lives on the chain it is signed on.
    if (live.chainId === null || !live.isSupported || live.routerAddress === null) {
      setError(
        'Your wallet is on a network payments can’t start on — switch to a supported network above.',
      )
      return
    }
    const chainId = live.chainId
    const routerAddress: Address = live.routerAddress

    setSubmitting(true)
    try {
      let walletClient = await getWalletClient(primaryWallet)
      // Pin the wallet to the resolved chain BEFORE the write (the AdminPanel
      // prepareWallet pattern) — switch-or-throw, never a wrong-chain tx. After
      // a switch, re-derive the client so its chain snapshot matches the chain
      // the tx is submitted on (registerMerchant passes `chain: walletClient.chain`).
      const switched = await ensureChain(walletClient, chainId)
      if (switched) walletClient = await getWalletClient(primaryWallet)
      const publicClient = getPublicClient(chainId)
      const payout = walletClient.account?.address as Address

      // Use the resolved ENS address when present, then the raw 0x input, then zero.
      const effectiveFeeRecipient: Address =
        resolvedAddr ??
        ((trimmedFeeRecipient || '0x0000000000000000000000000000000000000000') as Address)

      const { merchantId, txHash } = await registerMerchant(
        walletClient,
        publicClient,
        routerAddress,
        {
          payout,
          feeRecipient: effectiveFeeRecipient,
          feeBps: 0,
          nameHash: keccak256(toHex(trimmedName)),
        },
      )

      // Label the wallet with the business name (local, plain label — the chip
      // shows it instead of a bare 0x…; external wallets never share their own
      // account nickname with a site, so this is the user's first visible name).
      setWalletLabel(payout, trimmedName)

      onRegistered({
        merchantId,
        txHash,
        name: trimmedName,
        priceUsd: price.toFixed(2),
        chainId,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Business name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Coffee"
          className="rounded-lg border border-input px-3 py-2 outline-none focus:border-rail"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Price (USD)</span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={priceUsd}
          onChange={(e) => setPriceUsd(e.target.value)}
          className="rounded-lg border border-input px-3 py-2 outline-none focus:border-rail"
        />
      </label>

      {/* Optional plumbing lives behind a disclosure so the visible form is just
          "name + price + button" — the two answers every merchant actually has.
          The input stays mounted (details keeps children in the DOM), so ENS
          resolution and the existing tests behave identically. */}
      <details className="rounded-lg border border-border px-3 py-2 text-sm [&[open]]:pb-3">
        <summary className="cursor-pointer select-none font-medium text-muted-foreground">
          Advanced <span className="font-normal">— fee recipient (optional)</span>
        </summary>

        <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">
          Fee recipient <span className="text-muted-foreground">(optional — 0x address or ENS name)</span>
        </span>
        <input
          type="text"
          value={feeRecipient}
          onChange={(e) => {
            setFeeRecipient(e.target.value)
            // Clear stale resolution whenever the field changes.
            setResolvedFeeRecipient(null)
            setEnsError(null)
          }}
          onBlur={() => {
            const trimmed = feeRecipient.trim()
            if (trimmed && isEnsInput(trimmed)) {
              void resolveFeeRecipientENS()
            }
          }}
          placeholder="0x… or name.eth (defaults to your payout)"
          className="rounded-lg border border-input px-3 py-2 font-mono text-sm outline-none focus:border-rail"
        />
        {ensResolving ? (
          <span className="text-xs text-muted-foreground" data-testid="ens-resolving">
            Resolving ENS name…
          </span>
        ) : resolvedFeeRecipient ? (
          <span className="text-xs text-green-700" data-testid="ens-resolved">
            Resolved to {resolvedFeeRecipient}
          </span>
        ) : ensError ? (
          <span className="text-xs text-red-600" data-testid="ens-error">
            {ensError}
          </span>
        ) : null}
        </label>
      </details>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {primaryWallet ? (
        <div className="flex flex-col gap-2">
          {/* WHERE this registration lands: the wallet's LIVE network, always
              visible right above the action that signs on it. */}
          <NetworkBadge />
          <button
            type="submit"
            disabled={submitting || !live.isSupported}
            className="rounded-lg bg-rail px-4 py-2.5 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Registering…' : 'Create payment link'}
          </button>
          {live.isSupported && live.chain ? (
            <p className="text-xs text-muted-foreground">
              Your merchant seat will be created on {live.chain.name}.
            </p>
          ) : (
            <p className="text-xs text-amber-600" data-testid="unsupported-network">
              Payments can’t start on this network — use a switch button above to continue.
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowAuthFlow(true)}
          className="rounded-lg bg-rail px-4 py-2.5 font-medium text-white transition-opacity hover:opacity-90"
        >
          Connect wallet to continue
        </button>
      )}
    </form>
  )
}
