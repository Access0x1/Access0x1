/**
 * /api/oidc/verify — verify a "Sign in with Google" / OIDC ID token and record
 * the `oidc` method into the user's Super Verification profile.
 *
 * POST /api/oidc/verify  body: { user: 0x…, token: <oidc id token>, agent?: 0x… }
 *
 * The user signs in with an OIDC provider (Google by default, any OIDC issuer or
 * the operator's own backend by env), the browser sends the resulting ID token,
 * and we verify it SERVER-SIDE against the issuer's JWKS (signature + iss + aud +
 * exp). On success we:
 *   1. dedup the OIDC account — one (issuer, subject) verifies once, mirroring the
 *      World ID nullifier gate, so a single account can't farm badges across
 *      wallets (repeat ⇒ 409);
 *   2. record the `oidc` method against the user's wallet key, which stacks into
 *      Standard → Verified → Super Verified alongside World ID / ENS / Dynamic /
 *      on-chain;
 *   3. "verify for all": if the token also carries an agent claim, the verified
 *      agent id is recorded too and echoed back.
 *
 * Honesty (law #4): when OIDC is unconfigured (no audience / client id) the route
 * fails soft with `not_configured` (503) and records NOTHING — it never fakes a
 * pass. It is verify-only: it never signs, holds, or moves money, and never leaks
 * a secret or a payout address. GENERIC: no vendor name appears in this code.
 */

import { NextResponse } from 'next/server'
import { getProfile, addMethod, normalizeUserKey } from '@/lib/verification/store'
import {
  computeTier,
  computeTrustScore,
  nextStepToSuper,
  type VerificationProfile,
} from '@/lib/verification/tiers'
import { verifyOidcToken } from '@/lib/oidc/verify'
import { oidcIssuer } from '@/lib/oidc/config'
import { claimSubject } from '@/lib/oidc/subjectStore'

export const dynamic = 'force-dynamic'

/** Shape the profile + derived fields the UI consumes (matches /api/verify). */
function profileResponse(
  user: string,
  profile: VerificationProfile,
  extra: { subject: string; email: string | null; agent: string | null },
) {
  return {
    user,
    methods: profile.methods,
    score: computeTrustScore(profile),
    tier: computeTier(profile),
    nextStep: nextStepToSuper(profile),
    // "verify for all" — the verified principals from the token.
    oidc: { subject: extra.subject, email: extra.email, agent: extra.agent },
  }
}

/** Map an OIDC verify error code to an HTTP status (no secret ever leaks). */
function statusForCode(code: string): number {
  switch (code) {
    case 'not_configured':
      return 503 // booth-gated / pre-setup — fail-soft, recorded nothing
    case 'jwks_unreachable':
      return 502 // provider keys unreachable — transient, not a forge
    case 'missing_token':
      return 400
    default:
      return 401 // token_invalid (bad signature / iss / aud / exp)
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  let user: string
  try {
    user = normalizeUserKey(body.user)
  } catch {
    return NextResponse.json({ error: 'bad_user' }, { status: 400 })
  }

  // The ID token may arrive as `token` (preferred) or `id_token` (OIDC's own
  // field name). Accept either so a raw provider response works as-is.
  const token =
    typeof body.token === 'string'
      ? body.token
      : typeof body.id_token === 'string'
        ? body.id_token
        : undefined

  // Verify the OIDC ID token for real (signature + issuer + audience + exp).
  const result = await verifyOidcToken(token)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, method: 'oidc' },
      { status: statusForCode(result.code) },
    )
  }

  // One OIDC account verifies once (anti-farm), mirroring the World ID nullifier
  // gate. A repeat account ⇒ 409, and we record nothing.
  const fresh = claimSubject(oidcIssuer(), result.identity.subject)
  if (!fresh) {
    return NextResponse.json({ error: 'already_verified', method: 'oidc' }, { status: 409 })
  }

  // Record the verified USER's `oidc` method — it stacks into the trust tier.
  const profile = addMethod(user, 'oidc')

  return NextResponse.json(
    profileResponse(user, profile, {
      subject: result.identity.subject,
      email: result.identity.email,
      agent: result.identity.agent,
    }),
    { status: 200 },
  )
}

export async function GET(request: Request): Promise<NextResponse> {
  // Read-only convenience: the current profile for a user (no token needed),
  // mirroring GET /api/verify so the UI can poll either endpoint.
  const { searchParams } = new URL(request.url)
  let user: string
  try {
    user = normalizeUserKey(searchParams.get('user') ?? undefined)
  } catch {
    return NextResponse.json({ error: 'bad_user' }, { status: 400 })
  }
  const profile = getProfile(user)
  return NextResponse.json({
    user,
    methods: profile.methods,
    score: computeTrustScore(profile),
    tier: computeTier(profile),
    nextStep: nextStepToSuper(profile),
  })
}
