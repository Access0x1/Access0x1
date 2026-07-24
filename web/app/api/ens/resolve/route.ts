/**
 * /api/ens/resolve — the CCIP-Read Payment Resolver gateway (READ).
 *
 * This is the off-chain data endpoint behind the ENSv2 "your name, your registry"
 * story: a merchant points their ENSv2 registry's resolver at the Access0x1 Payment
 * Resolver, and `pay.<merchant>.eth` resolves — via this gateway — to the merchant's
 * LIVE payout address and USD-pricing / settlement config, read off the audited
 * router at query time (never a stored, stale row). It is the exact answer the
 * on-chain {Access0x1PaymentResolver} computes, served for the common case where the
 * name lives on mainnet while settlement is on an L2/testnet.
 *
 *   GET /api/ens/resolve
 *     → { configured } capability probe (is the ENSv2 registry seam wired?)
 *   GET /api/ens/resolve?chainId=84532&merchantId=42
 *     → { configured, chainId, merchantId, payout, coinType, texts, resolver }
 *   GET /api/ens/resolve?chainId=84532&merchantId=42&key=click.access0x1.payout
 *     → { value }
 *
 * FAIL-SOFT (law #4): resolution is off the money path. An unknown seat, an
 * unconfigured chain, or an RPC hiccup returns a 200 with null values — never a 500,
 * never a fabricated address. No secret, no key, and no money passes through here.
 *
 * Honest scope: this serves the resolver's DATA layer (live records) over HTTP. The
 * signed EIP-3668 wrapper (an `OffchainLookup` answer signed for on-chain
 * verification) is the declared next rung — it needs an operator signer key and is
 * NOT implied live here; the on-chain resolver is the trust-minimized source of truth.
 */

import { NextResponse } from 'next/server'
import { isSettlementChain } from '@/lib/chains'
import {
  isEnsV2Configured,
  paymentResolverAddress,
  resolvePaymentRecords,
  resolveRecord,
} from '@/lib/ens/ensv2'

export const dynamic = 'force-dynamic'

/** Parse an untrusted merchantId query value into a non-negative bigint, or null. */
function parseMerchantId(raw: string | null): bigint | null {
  if (raw === null || raw.trim().length === 0) return null
  try {
    const id = BigInt(raw.trim())
    return id >= 0n ? id : null
  } catch {
    return null
  }
}

/** Parse an untrusted chainId query value into a positive integer, or null. */
function parseChainId(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) return null
  const n = Number(raw.trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const chainId = parseChainId(searchParams.get('chainId'))
  const merchantId = parseMerchantId(searchParams.get('merchantId'))
  const key = searchParams.get('key')?.trim() || undefined

  // No target ⇒ capability probe (the client hides/disables the ENSv2 affordance
  // when the registry seam is not wired, exactly like /api/docs-ask's GET probe).
  if (chainId === null && merchantId === null) {
    return NextResponse.json({ configured: isEnsV2Configured() })
  }

  // Malformed / unsupported target ⇒ fail-soft null (a resolution read must not 4xx
  // a caller that a cosmetic path would rather treat as "no record").
  if (chainId === null || merchantId === null || !isSettlementChain(chainId)) {
    return key
      ? NextResponse.json({ value: null })
      : NextResponse.json({ configured: isEnsV2Configured(), payout: null, texts: {} })
  }

  // Single-record form (one `addr`/`text` answer) — the CCIP-Read per-query shape.
  if (key) {
    const value = await resolveRecord(chainId, merchantId, key)
    return NextResponse.json({ value })
  }

  const records = await resolvePaymentRecords(chainId, merchantId)
  return NextResponse.json({
    configured: isEnsV2Configured(),
    chainId,
    merchantId: merchantId.toString(),
    payout: records?.payout ?? null,
    coinType: records?.coinType ?? null,
    texts: records?.texts ?? {},
    resolver: paymentResolverAddress(chainId),
  })
}
