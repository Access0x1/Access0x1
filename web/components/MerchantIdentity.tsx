'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { isAddress } from 'viem'
import { Check } from 'lucide-react'
import { verifiedPrimaryName } from '@/lib/ens'

/**
 * MerchantIdentity — the checkout "who am I paying" line.
 *
 * READ seam (ENSIP-19): on mount it asks {@link verifiedPrimaryName} for the
 * merchant payout address's VERIFIED primary name on the settlement chain. A
 * name is shown ONLY when ENS proves it forward-resolves back to that exact
 * address (forward == reverse) — otherwise the buyer sees the truncated 0x
 * address. The badge never invents a name and never blocks the page: it sits off
 * the money path (law #4), so any unconfigured-resolver / RPC / mismatch state
 * simply falls back to the address.
 *
 * The truncated address is the SAFE default rendered immediately (and while the
 * async check is in flight), so the buyer always sees the real payout
 * destination even if ENS is slow, off, or has no name for this address.
 */
export function MerchantIdentity({
  payout,
  chainId,
  rpcUrl,
}: {
  /** The merchant payout address funds will route to. */
  payout: string
  /** The settlement chain id (drives the ENSIP-11 coinType for reverse). */
  chainId: number
  /** Optional Mainnet RPC URL for the ENS resolution client. */
  rpcUrl?: string
}): ReactNode {
  // null = no verified name (the honest default: show the address). A name only
  // ever lands here after a real ENSIP-19 forward==reverse pass.
  const [name, setName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // verifiedPrimaryName NEVER throws (cosmetic, off the money path); the catch
    // is belt-and-suspenders so a rejected promise can't bubble into the render.
    void verifiedPrimaryName(payout, chainId, rpcUrl)
      .then((resolved) => {
        if (!cancelled) setName(resolved)
      })
      .catch(() => {
        if (!cancelled) setName(null)
      })
    return () => {
      cancelled = true
    }
  }, [payout, chainId, rpcUrl])

  return <MerchantIdentityView payout={payout} name={name} />
}

/**
 * Pure presentational identity line (no effects, no network) — rendered from a
 * resolved `name`. Split out so it is deterministically SSR-testable for both
 * states (verified vs address-fallback), mirroring how `SuperVerifiedBadge`
 * renders purely from props.
 *
 * `name` is the VERIFIED primary name (already passed forward==reverse) or null;
 * this component NEVER verifies and NEVER fabricates — it only decides whether to
 * show the supplied name + check or fall back to the truncated address.
 */
export function MerchantIdentityView({
  payout,
  name,
}: {
  payout: string
  /** The verified primary name, or null to show the truncated address. */
  name: string | null
}): ReactNode {
  const showName = name !== null && name.length > 0

  return (
    <p
      className="flex items-center gap-1.5 text-sm text-neutral-500"
      data-verified={showName ? 'true' : 'false'}
    >
      <span>Paying</span>
      {showName ? (
        <>
          <span className="font-medium text-ink">{name}</span>
          <Check className="size-3.5 text-green-600" aria-label="ENS verified" />
        </>
      ) : (
        <span className="font-medium text-ink" title={isAddress(payout) ? payout : undefined}>
          {truncateAddress(payout)}
        </span>
      )}
    </p>
  )
}

/**
 * Shorten an 0x address for display: `0x1234…cdef`. A non-address falls through
 * unchanged (we never reshape something we don't recognize as an address).
 */
export function truncateAddress(addr: string): string {
  if (!isAddress(addr)) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
