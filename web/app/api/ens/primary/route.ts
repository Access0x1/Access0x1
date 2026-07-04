/**
 * /api/ens/primary — the signed-in user's OWN verified primary ENS name (READ).
 *
 * GET /api/ens/primary?address=0x… → { name: string | null }
 *
 * This is the identity-namespace read that lets the app RECOGNIZE the connected
 * wallet's primary name and show it, instead of making the user type it. It calls
 * {@link verifiedPrimaryName} on ETHEREUM MAINNET (chain id 1, ENS coinType 60) —
 * the identity namespace where users actually set their primary name. It is a
 * DIFFERENT concern from the checkout payout badge (which reads the SETTLEMENT
 * chain's coinType); this route never touches the money path and never uses the
 * settlement/testnet chain for the identity name.
 *
 * FAIL-SOFT (law #4): a primary-name read is purely cosmetic identity — it must
 * never 500 and never throw. A bad address, an unconfigured resolver, an RPC
 * hiccup, or simply no primary name set all degrade to `{ name: null }` with a
 * 200. The client then shows the address, exactly as before. No secret, no payout
 * address, and no money ever passes through here.
 *
 * The mainnet RPC used is read SERVER-SIDE from `MAINNET_RPC_URL` (or the
 * `NEXT_PUBLIC_MAINNET_RPC_URL` documented in lib/ens.ts, for parity). Blank ⇒
 * viem's default public mainnet transport (the resolver still works keyless).
 */

import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { verifiedPrimaryName } from '@/lib/ens'

export const dynamic = 'force-dynamic'

/** Ethereum Mainnet — the identity namespace (coinType 60) primary names live in. */
const IDENTITY_CHAIN_ID = 1

/**
 * In-memory per-address cache of the resolved primary name. A primary name is a
 * slow-changing identity fact; caching it briefly spares the mainnet RPC a lookup
 * on every mount/navigation without ever staling for long. Keyed by lowercased
 * address; scoped to the server process (no external store, no secret).
 */
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { name: string | null; at: number }>()

/**
 * The mainnet RPC URL for the identity read, or undefined to use viem's default
 * public transport. Server-side only — never exposed to the client. Prefers the
 * server-only `MAINNET_RPC_URL`; falls back to the `NEXT_PUBLIC_MAINNET_RPC_URL`
 * name documented on {@link mainnetClient}. A blank value normalizes to undefined
 * (a wholesale-copied .env.example must never yield an empty RPC string).
 */
function mainnetRpcUrl(): string | undefined {
  const raw = (process.env.MAINNET_RPC_URL ?? process.env.NEXT_PUBLIC_MAINNET_RPC_URL ?? '').trim()
  return raw.length > 0 ? raw : undefined
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const address = (searchParams.get('address') ?? '').trim()

  // Not an address ⇒ no name (never guess, never throw). 200 by design: a
  // cosmetic identity read must not surface a 4xx that a caller has to handle.
  if (!isAddress(address)) {
    return NextResponse.json({ name: null })
  }

  const key = address.toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ name: hit.name })
  }

  // verifiedPrimaryName NEVER throws (it swallows every RPC/decode/revert to
  // null); the try/catch is belt-and-suspenders so this route can never 500.
  let name: string | null = null
  try {
    name = await verifiedPrimaryName(address, IDENTITY_CHAIN_ID, mainnetRpcUrl())
  } catch {
    name = null
  }

  cache.set(key, { name, at: Date.now() })
  return NextResponse.json({ name })
}
