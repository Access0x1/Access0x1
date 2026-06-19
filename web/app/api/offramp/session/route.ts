/**
 * POST /api/offramp/session — build a hosted fiat OFF-ramp ("cash out") session.
 *
 * "Send money back to the bank": the caller posts the SOURCE wallet (the wallet
 * selling crypto) + an optional crypto amount/asset/network/redirect, and this
 * route returns a hosted sell-widget URL for whichever provider env selects
 * (MoonPay / Transak / Coinbase Offramp — chosen by OFFRAMP_PROVIDER, NONE
 * hardcoded). The user cashes out there; the fiat lands in their bank/card. The
 * mirror of /api/onramp/session — it NEVER touches the Solidity money path.
 *
 * FAIL-SOFT (law #4): unconfigured ⇒ 503 `not_configured`, building NOTHING — never
 * a guessed sell URL, address, or provider. A malformed source address ⇒ 400. No
 * SECRET ever reaches the response: only the public hosted URL + the partner-fee %.
 *
 * Standard Web `Request`/`NextResponse` App Router handler.
 */

import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { buildOfframpSession } from '@/lib/onramp/offramp'
import { safeReturnUrl } from '@/lib/safeUrl'

export const dynamic = 'force-dynamic'

interface OfframpSessionBody {
  /** Source wallet selling crypto (buyer/agent/merchant EOA). REQUIRED. */
  address?: string
  /** Crypto amount to sell, as a string (optional — the provider may prompt). */
  amount?: string
  /** Override the sold asset (defaults to the configured asset / USDC). */
  asset?: string
  /** Override the source network slug (defaults to the configured network). */
  network?: string
  /** Where the provider returns the user after the sell completes. */
  redirectUrl?: string
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: OfframpSessionBody
  try {
    body = (await request.json()) as OfframpSessionBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { address, amount, asset, network, redirectUrl } = body

  // Validate the source before building anything — never a guessed address.
  if (typeof address !== 'string' || !isAddress(address)) {
    return NextResponse.json({ error: 'address must be a valid 0x address' }, { status: 400 })
  }

  // Validate the redirect before forwarding it to the external provider: only an
  // https: URL passes; a javascript:/data:/http:/evil-origin value is dropped to
  // undefined so the provider gets NO redirect param (same root cause as C-1 —
  // red-report O-11). Never hand a tainted return URL to a third party.
  const result = buildOfframpSession({
    address: address as `0x${string}`,
    amount,
    asset,
    network,
    redirectUrl: safeReturnUrl(redirectUrl),
  })

  if (!result.ok) {
    // Fail-soft: unconfigured ⇒ 503 (built nothing); a malformed input ⇒ 400.
    const status = result.code === 'not_configured' ? 503 : 400
    return NextResponse.json({ error: result.code, reason: result.reason }, { status })
  }

  return NextResponse.json(
    { provider: result.provider, url: result.url, partnerFeePercent: result.partnerFeePercent },
    { status: 200 },
  )
}
