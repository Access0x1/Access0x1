import { NextResponse } from 'next/server'
import { getByMerchantId } from '@/lib/branding/store'
import { PUBLIC_BRANDING_CORS, toPublicBranding } from '@/lib/branding/response'

export const dynamic = 'force-dynamic'

/**
 * GET /api/branding/by-merchant/{id}
 *
 * The PUBLIC, read-only branding lookup the MetaMask Snap's `onTransaction`
 * fetches by on-chain merchant id (ADR unit 4 / D4 c, path 2). The Snap fetch
 * carries `Origin: null`, so the same permissive CORS as the slug route applies.
 * Returns the payout-free public payload; 404 when no tenant has that merchant
 * id (the Snap then falls back to the on-chain nameHash / "Merchant #id").
 *
 * `id` is validated as a non-negative integer string before the lookup — a junk
 * id is a clean 400, never a confusing 500.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  if (!/^[0-9]+$/.test(id)) {
    return NextResponse.json(
      { error: 'invalid_merchant_id' },
      { status: 400, headers: PUBLIC_BRANDING_CORS },
    )
  }
  const row = getByMerchantId(id)
  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: PUBLIC_BRANDING_CORS })
  }
  return NextResponse.json(toPublicBranding(row), { status: 200, headers: PUBLIC_BRANDING_CORS })
}

/** CORS preflight (the Snap fetch + any cross-origin reader). */
export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: PUBLIC_BRANDING_CORS })
}
