'use client'

/**
 * usePrimaryEnsName — recognize the connected wallet's OWN primary ENS name.
 *
 * The signed-in user's primary name is an IDENTITY fact, not a payout fact: it
 * lives on Ethereum mainnet (coinType 60) and is set once, for the whole wallet.
 * This hook asks the server seam ({@link /api/ens/primary}) for the VERIFIED
 * primary name of `address` (forward == reverse, on mainnet) and returns it so
 * the UI can SHOW it — the IdentityChip renders it as the primary identity line,
 * and /verify prefills it — instead of making the user type their own name.
 *
 * Dormant-safe + fail-soft: no address ⇒ no fetch, `name` stays null. Any
 * transport error ⇒ null (the caller shows the address, exactly as before). The
 * server does the real ENS work; this is a thin client read that never throws.
 */

import { useEffect, useState } from 'react'

/** What the hook returns: the verified primary name (or null) + a loading flag. */
export interface PrimaryEnsName {
  /** The verified primary name (e.g. `yourname.eth`), or null when none/unknown. */
  name: string | null
  /** True while a fetch for the current address is in flight. */
  loading: boolean
}

/**
 * Fetch the verified primary name for an address from the server seam. Pure and
 * effect-free so it is unit-testable in the node env (no DOM): a missing/blank
 * address short-circuits to null WITHOUT a network call; otherwise it GETs
 * `/api/ens/primary` and reads `{ name }`. NEVER throws — a non-2xx or a network
 * error resolves to null (the caller falls back to the address).
 *
 * @param address The connected wallet address (or undefined ⇒ no fetch).
 * @returns The verified primary name, or null.
 */
export async function fetchPrimaryEnsName(address?: string): Promise<string | null> {
  const addr = address?.trim()
  if (!addr) return null
  try {
    const res = await fetch(`/api/ens/primary?address=${encodeURIComponent(addr)}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    const json = (await res.json()) as { name?: string | null }
    return typeof json.name === 'string' && json.name.length > 0 ? json.name : null
  } catch {
    return null
  }
}

/**
 * React hook: resolve `address`'s verified primary ENS name via the server seam,
 * re-fetching whenever the address changes. Mirrors MerchantIdentity's effect
 * shape (cancelled-flag guard so a stale response can't overwrite a newer one).
 *
 * @param address The connected wallet address (undefined ⇒ dormant, name null).
 * @returns `{ name, loading }`.
 */
export function usePrimaryEnsName(address?: string): PrimaryEnsName {
  const [name, setName] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const addr = address?.trim()
    // Dormant: no address ⇒ no fetch, and clear any prior name.
    if (!addr) {
      setName(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    fetchPrimaryEnsName(addr)
      .then((resolved) => {
        if (!cancelled) setName(resolved)
      })
      .catch(() => {
        // fetchPrimaryEnsName never rejects; belt-and-suspenders so a rejected
        // promise can never bubble into render.
        if (!cancelled) setName(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [address])

  return { name, loading }
}
