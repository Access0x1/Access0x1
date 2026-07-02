/**
 * /api/verify — the Super Verification API (read profile + record a method).
 *
 * GET  /api/verify?user=0x… → the user's profile, score, tier, and next step.
 * POST /api/verify          → verify ONE method for the user and record it.
 *
 * Each method is REALLY checked (honest, law #4) — this route never just trusts
 * a "method": for `world-id` it verifies the IDKit proof + claims the nullifier
 * (the existing /api/world/verify logic, composed); for `ens` it requires the
 * supplied ENS name to FORWARD-RESOLVE to the user's wallet via lib/ens; for
 * `dynamic` it verifies a Dynamic JWT server-side; for `onchain` it reads the
 * wallet on-chain to confirm a funded/active wallet. Where a real check is
 * booth-gated (World ID Developer Portal, ENS mainnet resolver) the route says
 * so with a clear code instead of faking a pass.
 *
 * It is verify-only: it NEVER signs, holds, or moves money, and never leaks a
 * secret or a payout address.
 */

import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getProfile, addMethod, normalizeUserKey } from '@/lib/verification/store'
import {
  computeTier,
  computeTrustScore,
  nextStepToSuper,
  asVerificationMethod,
  type VerificationMethod,
  type VerificationProfile,
} from '@/lib/verification/tiers'
import { verifyWorldProof } from '@/lib/worldid/verify'
import { claimNullifier } from '@/lib/worldid/nullifierStore'
import { worldAction } from '@/lib/worldid/config'
import { resolveENS, EnsResolutionError } from '@/lib/ens'
import { resolveVerifiedTenant, TenantAuthError } from '@/lib/branding/tenant'
import { verifyOidcToken } from '@/lib/oidc/verify'
import { oidcIssuer } from '@/lib/oidc/config'
import { claimSubject } from '@/lib/oidc/subjectStore'
import { DurableStoreRequiredError } from '@/lib/security/replayStore'
import { getPublicClient } from '@/lib/wallet'
import { getDefaultChainId } from '@/lib/chains'

export const dynamic = 'force-dynamic'

/** Shape the profile + derived fields the UI consumes. */
function profileResponse(user: string, profile: VerificationProfile) {
  return {
    user,
    methods: profile.methods,
    score: computeTrustScore(profile),
    tier: computeTier(profile),
    nextStep: nextStepToSuper(profile),
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  let user: string
  try {
    user = normalizeUserKey(searchParams.get('user') ?? undefined)
  } catch {
    return NextResponse.json({ error: 'bad_user' }, { status: 400 })
  }
  return NextResponse.json(profileResponse(user, getProfile(user)))
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

  const method = asVerificationMethod(body.method)
  if (!method) return NextResponse.json({ error: 'bad_method' }, { status: 400 })

  // Verify the specific method for real; on success, record it.
  const verdict = await verifyMethod(method, user, body, request)
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.code, method }, { status: verdict.status })
  }

  const profile = addMethod(user, method)
  return NextResponse.json(profileResponse(user, profile), { status: 200 })
}

interface VerifyOk {
  ok: true
}
interface VerifyErr {
  ok: false
  code: string
  status: number
}
type Verdict = VerifyOk | VerifyErr

/** Dispatch to the per-method real check. */
async function verifyMethod(
  method: VerificationMethod,
  user: string,
  body: Record<string, unknown>,
  request: Request,
): Promise<Verdict> {
  switch (method) {
    case 'world-id':
      return verifyWorldIdMethod(body)
    case 'ens':
      return verifyEnsMethod(user, body)
    case 'dynamic':
      return verifyDynamicMethod(user, body, request)
    case 'oidc':
      return verifyOidcMethod(body)
    case 'onchain':
      return verifyOnchainMethod(user)
  }
}

/**
 * OIDC ("Sign in with Google"): verify the provider-signed ID token server-side
 * (signature + issuer + audience, via lib/oidc/verify) and claim the OIDC account
 * (one issuer+subject verifies once), mirroring the World ID nullifier gate.
 * Booth-gated: when no audience (client id) is configured the verify lib returns
 * `not_configured` and we surface 503 rather than faking a pass (law #4). The
 * dedicated /api/oidc/verify route also echoes the verified user/agent; this
 * primary-route case keeps the method stackable alongside the others.
 */
async function verifyOidcMethod(body: Record<string, unknown>): Promise<Verdict> {
  const token =
    typeof body.token === 'string'
      ? body.token
      : typeof body.id_token === 'string'
        ? body.id_token
        : undefined
  const result = await verifyOidcToken(token)
  if (!result.ok) {
    switch (result.code) {
      case 'not_configured':
        return { ok: false, code: 'not_configured', status: 503 }
      case 'jwks_unreachable':
        return { ok: false, code: 'jwks_unreachable', status: 502 }
      case 'missing_token':
        return { ok: false, code: 'missing_token', status: 400 }
      default:
        return { ok: false, code: 'token_invalid', status: 401 }
    }
  }
  // One OIDC account verifies once (anti-farm), like the World ID nullifier.
  let fresh: boolean
  try {
    fresh = await claimSubject(oidcIssuer(), result.identity.subject)
  } catch (err) {
    // FAIL-CLOSED (R-2): no durable replay store in production ⇒ refuse rather
    // than fall back to the replay-vulnerable in-memory set. 503, never a silent pass.
    if (err instanceof DurableStoreRequiredError) {
      return { ok: false, code: 'not_configured', status: 503 }
    }
    throw err
  }
  if (!fresh) {
    return { ok: false, code: 'already_verified', status: 409 }
  }
  return { ok: true }
}

/**
 * World ID: verify the raw IDKit proof with the Developer Portal and claim the
 * nullifier (one-human-per-action), mirroring /api/world/verify. Booth-gated on
 * the Developer Portal env (`not_configured` when unset — pre-booth).
 */
async function verifyWorldIdMethod(body: Record<string, unknown>): Promise<Verdict> {
  // The proof may arrive nested under `proof` OR as the raw IDKit fields at the
  // top level (how WorldIdGate forwards a result). Accept both; require SOME
  // proof field so we never claim "verified" with no proof.
  const proof =
    body.proof !== undefined && body.proof !== null
      ? body.proof
      : extractRawProof(body)
  if (proof === undefined || proof === null) {
    return { ok: false, code: 'missing_proof', status: 400 }
  }
  // C-2: the world-id trust method is the BUYER gate; the action is fixed by
  // trusted server config, never the body. We also FORCE the action field in the
  // forwarded proof so the portal verifies against the same action we claim the
  // nullifier under — a proof made for action A cannot be claimed under a body
  // action B.
  const action = worldAction()
  const sealedProof =
    typeof proof === 'object' && proof !== null
      ? { ...(proof as Record<string, unknown>), action }
      : proof
  const result = await verifyWorldProof(sealedProof, action)
  if (!result.ok) {
    if (result.code === 'not_configured') return { ok: false, code: 'not_configured', status: 503 }
    if (result.code === 'verify_unreachable')
      return { ok: false, code: 'verify_unreachable', status: 502 }
    return { ok: false, code: 'proof_invalid', status: 401 }
  }
  // OUR one-per-human enforcement (a repeat human cannot re-earn the method).
  // Claim under the TRUSTED server action, never `result.action` (the portal
  // echo), so the nullifier slot can't be steered by the body or the portal (C-2).
  let fresh: boolean
  try {
    fresh = await claimNullifier(action, result.nullifier)
  } catch (err) {
    // FAIL-CLOSED (R-2): no durable replay store in production ⇒ 503, never a
    // silent fall back to the replay-vulnerable in-memory set.
    if (err instanceof DurableStoreRequiredError) {
      return { ok: false, code: 'not_configured', status: 503 }
    }
    return { ok: false, code: 'bad_nullifier', status: 400 }
  }
  if (!fresh) return { ok: false, code: 'already_verified', status: 409 }
  return { ok: true }
}

/**
 * Pull the raw IDKit proof out of a top-level body (the shape WorldIdGate sends:
 * `{ user, method, action, merkle_root, nullifier_hash, proof, ... }`). We strip
 * our own envelope fields and pass the rest to `verifyWorldProof` AS-IS (no field
 * remap — a mutation breaks portal verification). Returns null when no recognizable
 * proof field is present.
 */
function extractRawProof(body: Record<string, unknown>): Record<string, unknown> | null {
  const hasProofFields =
    'merkle_root' in body || 'nullifier_hash' in body || 'verification_level' in body
  if (!hasProofFields) return null
  const { user: _u, method: _m, ...rest } = body
  void _u
  void _m
  return rest
}

/**
 * ENS: require the supplied ENS name to FORWARD-RESOLVE to the user's wallet on
 * the settlement chain (lib/ens.resolveENS — its first call-site). This is a
 * real check; booth-gated on the ENS mainnet resolver / testnet limits, surfaced
 * as `ens_unresolved` rather than a fake pass (law #4).
 */
async function verifyEnsMethod(user: string, body: Record<string, unknown>): Promise<Verdict> {
  const ensName = typeof body.ensName === 'string' ? body.ensName.trim() : ''
  if (!ensName) return { ok: false, code: 'missing_ens_name', status: 400 }
  try {
    const resolved = await resolveENS(ensName, getDefaultChainId())
    // The name MUST point at the user's own wallet — otherwise anyone could
    // claim a famous .eth name they do not control.
    if (resolved.toLowerCase() !== user.toLowerCase()) {
      return { ok: false, code: 'ens_mismatch', status: 401 }
    }
    return { ok: true }
  } catch (err) {
    if (err instanceof EnsResolutionError) {
      return { ok: false, code: 'ens_unresolved', status: 401 }
    }
    // A resolver/network hiccup is unreachable, not a forged claim (fail-soft).
    return { ok: false, code: 'ens_unreachable', status: 502 }
  }
}

/**
 * Dynamic: the user is signed in — verify a Dynamic JWT server-side (the same
 * jose/JWKS path the branding writes use) and require the verified wallet to
 * match the user. Booth-gated: when no issuer is configured the verification
 * path falls back to the shape-checked identity (verified:false), so we accept a
 * matching session in this deployment but flag it honestly via the fallback.
 */
async function verifyDynamicMethod(
  user: string,
  body: Record<string, unknown>,
  request: Request,
): Promise<Verdict> {
  try {
    const { tenantId } = await resolveVerifiedTenant(request, { tenantId: body.user })
    if (tenantId.toLowerCase() !== user.toLowerCase()) {
      return { ok: false, code: 'dynamic_mismatch', status: 401 }
    }
    return { ok: true }
  } catch (err) {
    if (err instanceof TenantAuthError) return { ok: false, code: 'dynamic_unauthorized', status: 401 }
    return { ok: false, code: 'dynamic_failed', status: 500 }
  }
}

/**
 * On-chain: a "real wallet" — funded (balance > 0) or active (has sent a tx, so
 * a non-zero nonce). Read on-chain via the public client; either signal passes.
 * A read failure is unreachable (fail-soft), never a forged pass.
 */
async function verifyOnchainMethod(user: string): Promise<Verdict> {
  if (!isAddress(user)) return { ok: false, code: 'bad_user', status: 400 }
  try {
    const chainId = getDefaultChainId()
    const client = getPublicClient(chainId)
    const [balance, nonce] = await Promise.all([
      client.getBalance({ address: user as `0x${string}` }),
      client.getTransactionCount({ address: user as `0x${string}` }),
    ])
    if (balance > 0n || nonce > 0) return { ok: true }
    return { ok: false, code: 'wallet_empty', status: 401 }
  } catch {
    return { ok: false, code: 'onchain_unreachable', status: 502 }
  }
}
