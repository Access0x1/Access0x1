/**
 * GET /api/intents/[id] — the CUSTOMER-facing read (P0.3).
 *
 * Public on purpose: the intent id IS the capability (a 26-char ULID printed
 * in a QR — unguessable in practice, and everything it reveals is what the
 * pay screen must show anyway). The projection is deliberately narrow
 * ({@link toPublicIntent}): amount, chain, tokens, quote snapshot, status,
 * expiry. The tenant linkage, register attribution, and the cashier's note
 * NEVER cross this boundary — a customer paying $12.50 has no business
 * reading the merchant's internal bookkeeping.
 *
 * Expiry is settled by the STORE on read (lazy) — a checkout polling this
 * route sees `expired` the first request past the deadline, with no cron
 * involved anywhere.
 */
import { NextResponse } from 'next/server'

import { getIntent } from '@/lib/intents/store.js'
import { toPublicIntent } from '@/lib/intents/types.js'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const intent = getIntent(id)
  if (!intent) {
    return NextResponse.json({ error: 'intent_not_found' }, { status: 404 })
  }
  return NextResponse.json(
    { intent: toPublicIntent(intent) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
