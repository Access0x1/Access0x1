/**
 * POST /api/onramp/session — build a hosted fiat on-ramp checkout session.
 *
 * "Bring money from a bank": the caller posts the destination wallet (the buyer/
 * agent EOA) + an optional amount/asset/network/redirect, and this route returns a
 * hosted-checkout URL for whichever provider env selects (Coinbase Onramp /
 * MoonPay / Stripe / Circle / one-tap deposit — chosen by ONRAMP_PROVIDER, NONE
 * hardcoded). The user funds USDC there; it lands in their EOA and flows into the
 * existing pay path. This route NEVER touches the Solidity money path.
 *
 * FAIL-SOFT (law #4): when the on-ramp is unconfigured the route answers 503
 * `not_configured` and builds NOTHING — it never invents a checkout URL, address,
 * or provider. A malformed destination address ⇒ 400. No SECRET ever reaches the
 * response: only the public hosted URL (public params) is returned.
 *
 * Standard Web `Request`/`NextResponse` App Router handler.
 */

import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { buildOnrampSession } from '@/lib/onramp'
import { safeReturnUrl } from '@/lib/safeUrl'

export const dynamic = 'force-dynamic'

interface OnrampSessionBody {
  /** Destination wallet to fund (buyer/agent EOA). REQUIRED. */
  address?: string
  /** Fiat amount to fund, as a string (optional — the provider may prompt). */
  amount?: string
  /** Override the delivered asset (defaults to the configured asset / USDC). */
  asset?: string
  /** Override the delivery network slug (defaults to the configured network). */
  network?: string
  /** Where the provider returns the user after funding. */
  redirectUrl?: string
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: OnrampSessionBody
  try {
    body = (await request.json()) as OnrampSessionBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { address, amount, asset, network, redirectUrl } = body

  // Validate the destination before building anything — never a guessed address.
  if (typeof address !== 'string' || !isAddress(address)) {
    return NextResponse.json(
      { error: 'address must be a valid 0x address' },
      { status: 400 },
    )
  }

  // Validate the redirect before forwarding it to the external provider: only an
  // https: URL passes; a javascript:/data:/http:/evil-origin value is dropped to
  // undefined so the provider gets NO redirect param (same root cause as C-1 —
  // red-report O-11). Never hand a tainted return URL to a third party.
  const result = buildOnrampSession({
    address: address as `0x${string}`,
    amount,
    asset,
    network,
    redirectUrl: safeReturnUrl(redirectUrl),
  })

  if (!result.ok) {
    // Fail-soft: unconfigured ⇒ 503 (booth-gated / pre-setup, built nothing);
    // a malformed input that slipped past the address check ⇒ 400.
    const status = result.code === 'not_configured' ? 503 : 400
    return NextResponse.json({ error: result.code, reason: result.reason }, { status })
  }

  return NextResponse.json(
    { provider: result.provider, url: result.url, partnerFeePercent: result.partnerFeePercent },
    { status: 200 },
  )
}
