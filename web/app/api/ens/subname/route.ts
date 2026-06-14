/**
 * /api/ens/subname — issue a gasless ENS subname `<label>.<PARENT>.eth` for a
 * merchant via Namestone, writing USD-pricing / settlement config into ENS TEXT
 * RECORDS.
 *
 * POST /api/ens/subname
 *   body: { label: "merchant-42", owner: "0x…", texts?: [{ key, value }, …] }
 *   — OR the onboarding shape —
 *   body: { merchantId: "42", owner: "0x…", router?: "0x…", chainId?: 84532 }
 *
 * The PARENT (`ENS_SUBNAME_PARENT`) and the API key (`NAMESTONE_API_KEY`) are read
 * SERVER-SIDE from env in `lib/ens-subnames.ts` — never hardcoded, never echoed.
 *
 * FAIL-SOFT (law #4): when the seam is unconfigured (missing key OR parent) the
 * route returns 503 `not_configured` and DOES NOTHING — it never fakes a name and
 * never calls the network. It writes only display/config records: no money, no
 * key, no payout address ever passes through here.
 */

import { NextResponse } from 'next/server'
import {
  issueMerchantSubname,
  issueSubname,
  type SubnameIssueResult,
  type SubnameText,
} from '@/lib/ens-subnames'

export const dynamic = 'force-dynamic'

/** Map a subname-issue error code to an HTTP status (no secret ever leaks). */
function statusForCode(code: 'not_configured' | 'bad_input' | 'namestone_error'): number {
  switch (code) {
    case 'not_configured':
      return 503 // seam OFF (no key / no parent) — fail-soft, did nothing
    case 'bad_input':
      return 400 // missing/invalid label or owner — never issue against a guess
    default:
      return 502 // upstream Namestone error — transient, not a forge
  }
}

/** Narrow an untrusted `texts` value into `SubnameText[]` (drops malformed rows). */
function parseTexts(value: unknown): SubnameText[] {
  if (!Array.isArray(value)) return []
  const out: SubnameText[] = []
  for (const row of value) {
    if (
      row &&
      typeof row === 'object' &&
      typeof (row as { key?: unknown }).key === 'string' &&
      typeof (row as { value?: unknown }).value === 'string'
    ) {
      out.push({ key: (row as SubnameText).key, value: (row as SubnameText).value })
    }
  }
  return out
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const owner = typeof body.owner === 'string' ? body.owner : ''

  let result: SubnameIssueResult
  // Onboarding shape (merchantId present) maps to merchant-<id> + config records.
  if (body.merchantId !== undefined && body.merchantId !== null) {
    result = await issueMerchantSubname({
      id: String(body.merchantId),
      owner,
      router: typeof body.router === 'string' ? body.router : undefined,
      chainId: typeof body.chainId === 'number' ? body.chainId : undefined,
    })
  } else {
    // Generic shape: an explicit label + arbitrary text records.
    result = await issueSubname({
      label: typeof body.label === 'string' ? body.label : '',
      owner,
      texts: parseTexts(body.texts),
    })
  }

  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, ...(result.detail ? { detail: result.detail } : {}) },
      { status: statusForCode(result.code) },
    )
  }

  return NextResponse.json(
    { name: result.name, label: result.label, parent: result.parent, owner: result.owner },
    { status: 200 },
  )
}
