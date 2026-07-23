/**
 * ensv2.ts — ENSv2 "your name, your registry" seam + the live payment-record
 * source that backs a CCIP-Read Payment Resolver.
 *
 * THE BRAND-NEW ENS SHAPE. ENSv1 is one flat registry: a name stores `name →
 * address` once. ENSv2 makes every name own its own registry and set its own
 * resolver, and resolution walks the hierarchy to the deepest resolver. Access0x1
 * exploits that to turn a name from a LOOKUP into a LIVE PAYMENT ENDPOINT:
 * `pay.<merchant>.eth` is not a stored row — it is a resolver that answers from the
 * merchant's CURRENT on-chain router state at query time. This module is the
 * OFF-CHAIN mirror of {Access0x1PaymentResolver} (src/ens/Access0x1PaymentResolver
 * .sol): given a settlement chain + merchant seat, it reads the live merchant off
 * the audited router and produces the ENS `addr` + `com.access0x1.*` text records a
 * gateway serves — the exact answer the on-chain resolver computes, for the common
 * case where the ENS name lives on mainnet while settlement is on an L2/testnet.
 *
 * FAIL-SOFT (law #4): a resolution read is off the money path. An unknown seat, an
 * unconfigured chain, or an RPC hiccup degrades to `null` — never a thrown error,
 * never a fabricated address. The ENSv2 registry ADDRESSES are alpha and read from
 * env (`NEXT_PUBLIC_ENSV2_*`), never hardcoded; blank ⇒ the seam reports
 * unconfigured and callers fall back to the existing Namestone / Universal-Resolver
 * path in `lib/ens.ts` and `lib/ens-subnames.ts` (nothing breaks).
 */

import { createPublicClient, http, isAddress, type Address, type PublicClient } from 'viem'
import { getChain, getRouterAddress, getRpcUrl } from '@/lib/chains'
import { getMerchant } from '@/lib/contracts'
import { toCoinType } from '@/lib/ens'
import { SUBNAME_TEXT_KEYS } from '@/lib/ens-subnames'

/** The zero address — a router `merchants(id).owner` of zero means "never registered". */
const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * The live `com.access0x1.*` text-record key set the resolver serves, kept in
 * lockstep with {SUBNAME_TEXT_KEYS} (the Namestone/offchain issuer) AND with the
 * on-chain resolver's `_KEY_*` constants — one identical schema across all three
 * issuers. Adds `payout` on top of the merchant-config keys.
 */
export const PAYMENT_TEXT_KEYS = {
  ...SUBNAME_TEXT_KEYS,
  /** The merchant's current payout address (hex string). */
  payout: 'com.access0x1.payout',
} as const

/** The ENSv2 registry pointers, read from env (alpha addresses — confirm from ENS docs). */
export interface EnsV2Config {
  /** The ENSv2 Root Registry address (mainnet). */
  rootRegistry: Address | null
  /** The ENSv2 `.eth` Registry address (mainnet). */
  ethRegistry: Address | null
}

/** Read a `NEXT_PUBLIC_*` address var, normalizing blank/invalid to null (fail-soft). */
function envAddress(name: string): Address | null {
  const raw = (process.env[name] ?? '').trim()
  return raw.length > 0 && isAddress(raw) ? (raw as Address) : null
}

/**
 * The ENSv2 registry configuration from env. Both blank ⇒ the ENSv2 seam is OFF
 * and callers use the existing ENSv1/Universal-Resolver path.
 */
export function ensV2Config(): EnsV2Config {
  return {
    rootRegistry: envAddress('NEXT_PUBLIC_ENSV2_ROOT_REGISTRY'),
    ethRegistry: envAddress('NEXT_PUBLIC_ENSV2_ETH_REGISTRY'),
  }
}

/**
 * The per-chain on-chain {Access0x1PaymentResolver} address for `chainId`, read
 * from `NEXT_PUBLIC_ENSV2_RESOLVER_<chainId>` (never hardcoded). Null when unset —
 * the gateway still serves live records from the router directly; this is only the
 * pointer a merchant's ENSv2 registry sets its resolver to.
 */
export function paymentResolverAddress(chainId: number): Address | null {
  return envAddress(`NEXT_PUBLIC_ENSV2_RESOLVER_${chainId}`)
}

/**
 * True iff the ENSv2 registry-per-name seam is configured (both registries set).
 * Mirrors the `isSubnameIssuanceConfigured()` gate style — a probe the UI/route
 * reads to decide between the ENSv2 path and the ENSv1 fallback.
 */
export function isEnsV2Configured(): boolean {
  const cfg = ensV2Config()
  return cfg.rootRegistry !== null && cfg.ethRegistry !== null
}

/** The live payment records for a bound name — the resolver's computed answer. */
export interface PaymentRecords {
  /** The merchant's current payout address on `chainId`. */
  payout: Address
  /** The ENSIP-11 coinType for `chainId` (the multichain `addr` answers only this). */
  coinType: number
  /** The live `com.access0x1.*` text records (config computed from the router/chain). */
  texts: Record<string, string>
}

/**
 * Build a read-only viem client for a settlement chain, server-side. Never used for
 * signing; only for the live `merchants(id)` read the resolver mirrors.
 */
function chainClient(chainId: number): PublicClient {
  return createPublicClient({ chain: getChain(chainId), transport: http(getRpcUrl(chainId)) })
}

/**
 * Resolve the LIVE ENS payment records for `merchantId` on `chainId` by reading the
 * audited router at query time — the off-chain twin of the on-chain resolver's
 * `addr`/`text`. Returns `null` (fail-soft) when the seat was never registered
 * (`owner == 0`), the chain is unconfigured, or any read fails. NEVER throws and
 * NEVER fabricates an address.
 *
 * @param chainId    The settlement chain whose router holds the seat.
 * @param merchantId The router merchant seat (as a bigint-coercible value).
 * @param rpcUrl     Optional RPC override (else the chain's configured/public RPC).
 */
export async function resolvePaymentRecords(
  chainId: number,
  merchantId: bigint,
  rpcUrl?: string,
): Promise<PaymentRecords | null> {
  let router: Address
  try {
    router = getRouterAddress(chainId)
  } catch {
    return null // no router configured for this chain ⇒ nothing to resolve.
  }

  try {
    const client = rpcUrl
      ? createPublicClient({ chain: getChain(chainId), transport: http(rpcUrl) })
      : chainClient(chainId)
    const merchant = await getMerchant(client, router, merchantId)

    // Never-registered seat ⇒ no records (never the zero address as a "payout").
    if (!merchant.owner || merchant.owner.toLowerCase() === ZERO) return null

    const texts: Record<string, string> = {
      [PAYMENT_TEXT_KEYS.merchantId]: merchantId.toString(),
      [PAYMENT_TEXT_KEYS.router]: router,
      [PAYMENT_TEXT_KEYS.chainId]: String(chainId),
      // The router USD-prices every payment — a truthful constant, not a guess.
      [PAYMENT_TEXT_KEYS.pricingCurrency]: 'USD',
      [PAYMENT_TEXT_KEYS.payout]: merchant.payout,
    }

    return { payout: merchant.payout, coinType: toCoinType(chainId), texts }
  } catch {
    // RPC / decode error ⇒ fail-soft. The gateway answers "no record", never 500s.
    return null
  }
}

/**
 * Serve a single ENS record for a name — the shape a CCIP-Read gateway returns for
 * one `addr`/`text` query. `key` selects a text record; omit it (or pass the addr
 * sentinel) to get the payout address. Returns `null` when unbound/unknown.
 *
 * @param chainId    The settlement chain.
 * @param merchantId The router seat.
 * @param key        A `com.access0x1.*` text key, or undefined for the address.
 */
export async function resolveRecord(
  chainId: number,
  merchantId: bigint,
  key?: string,
): Promise<string | null> {
  const records = await resolvePaymentRecords(chainId, merchantId)
  if (!records) return null
  if (!key || key.length === 0) return records.payout
  return records.texts[key] ?? null
}
