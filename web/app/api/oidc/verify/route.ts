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
import {
  getProfile,
  addMethod,
  addAgentMethod,
  normalizeUserKey,
  normalizeAgentKey,
} from '@/lib/verification/store'
import {
  computeTier,
  computeTrustScore,
  nextStepToSuper,
  type TrustTier,
  type VerificationMethod,
  type VerificationProfile,
} from '@/lib/verification/tiers'
import { verifyOidcToken } from '@/lib/oidc/verify'
import { oidcIssuer } from '@/lib/oidc/config'
import { claimSubject } from '@/lib/oidc/subjectStore'
import { DurableStoreRequiredError } from '@/lib/security/replayStore'

export const dynamic = 'force-dynamic'

/** The derived agent-profile block echoed back when the token bound an agent. */
interface AgentBlock {
  agentId: string
  methods: VerificationMethod[]
  score: number
  tier: TrustTier
}

/** Shape the profile + derived fields the UI consumes (matches /api/verify). */
function profileResponse(
  user: string,
  profile: VerificationProfile,
  extra: {
    subject: string
    email: string | null
    agent: string | null
    agentProfile: AgentBlock | null
  },
) {
  return {
    user,
    methods: profile.methods,
    score: computeTrustScore(profile),
    tier: computeTier(profile),
    nextStep: nextStepToSuper(profile),
    // "verify for all" — the verified principals from the token.
    oidc: { subject: extra.subject, email: extra.email, agent: extra.agent },
    // When the token bound a valid agentId, the AGENT profile we recorded the OIDC
    // method against (so "this agent is Google-verified" is durably queryable).
    agentProfile: extra.agentProfile,
  }
}

/**
 * Record the verified OIDC method against the AGENT when the token's agent claim is
 * a valid bytes32 agentId, and return the derived agent block.
 *
 * FAIL-SOFT: a missing claim, or a present-but-malformed claim (not a bytes32 agent
 * id), records nothing on the agent and returns null — it NEVER throws and never
 * blocks the user's own verification. The user method has already been recorded by
 * the caller; binding the agent is strictly additive.
 *
 * @param agentClaim - the raw `agent` claim off the verified token (may be null).
 * @returns the recorded agent block, or null when there was no bindable agent.
 */
function bindAgentMethod(agentClaim: string | null): AgentBlock | null {
  if (agentClaim === null) return null
  let agentId: string
  try {
    agentId = normalizeAgentKey(agentClaim)
  } catch {
    // A token may carry a non-agentId value in the claim (e.g. a provider's own
    // opaque id). That is not a forge and not an error: we simply do not bind an
    // agent profile, and the user verification still stands.
    return null
  }
  const agentProfile = addAgentMethod(agentId, 'oidc')
  return {
    agentId,
    methods: agentProfile.methods,
    score: computeTrustScore(agentProfile),
    tier: computeTier(agentProfile),
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
  let fresh: boolean
  try {
    fresh = await claimSubject(oidcIssuer(), result.identity.subject)
  } catch (err) {
    // FAIL-CLOSED (R-2): no durable replay store in production ⇒ refuse rather
    // than fall back to the replay-vulnerable in-memory set (which would let one
    // OIDC account re-farm badges after a restart). 503, never a silent pass.
    if (err instanceof DurableStoreRequiredError) {
      return NextResponse.json({ error: 'not_configured', method: 'oidc' }, { status: 503 })
    }
    throw err
  }
  if (!fresh) {
    return NextResponse.json({ error: 'already_verified', method: 'oidc' }, { status: 409 })
  }

  // Record the verified USER's `oidc` method — it stacks into the trust tier.
  const profile = addMethod(user, 'oidc')

  // "Verify for all": if the verified token carried a valid agentId, bind the OIDC
  // method to the AGENT profile too, so "this agent is Google-verified" is durably
  // queryable. Fail-soft — a missing/malformed agent claim records nothing extra.
  const agentProfile = bindAgentMethod(result.identity.agent)

  return NextResponse.json(
    profileResponse(user, profile, {
      subject: result.identity.subject,
      email: result.identity.email,
      agent: result.identity.agent,
      agentProfile,
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
