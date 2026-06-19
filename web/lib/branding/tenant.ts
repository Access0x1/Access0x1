/**
 * tenant.ts — resolve the calling tenant id for a branding WRITE (ADR D1/D2).
 *
 * A tenant is identified by their Dynamic sign-in. The SECURE path verifies a
 * Dynamic-issued JWT SERVER-SIDE (via Dynamic's JWKS) and derives the tenant id
 * from the cryptographically-verified wallet claim — the client can no longer
 * just assert "I am wallet 0xabc…" by putting it in the body. This follows the
 * `authenticateApiToken` precedent in `lib/agent/dynamicAgentWallet.ts` (server
 * verifies the issuer, never trusts the client) and uses `jose` (already present
 * via the Dynamic SDK) to verify the RS256 token against the remote JWKS.
 *
 * BOOTH-GATED FALLBACK (honest): full verification needs the Dynamic environment
 * id (`NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID`, public) to locate the JWKS. When that
 * env is unset — the pre-booth / local-demo state — there is no issuer to verify
 * against, so we FALL BACK to the prior behavior (shape-validate the body
 * `tenantId`) and mark the result `verified: false`. When the env IS set and a
 * `Authorization: Bearer <jwt>` header is present, the token is verified and a
 * body `tenantId` that disagrees with the verified wallet is REJECTED.
 *
 * Either way the result is a normalized 0x-40-hex tenant id; the difference is
 * whether it was cryptographically proven (`verified`) or merely shape-checked.
 *
 * The PUBLIC read endpoints ({slug}, by-merchant) need none of this — they are
 * read-only by slug / merchant id. Only the tenant-scoped reads/writes resolve a
 * tenant.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

/** Thrown when a write request carries no usable / no verifiable tenant identity. */
export class TenantAuthError extends Error {
  constructor(message = 'Sign in to save your branding.') {
    super(message)
    this.name = 'TenantAuthError'
  }
}

/** A resolved tenant id plus whether it was cryptographically verified. */
export interface ResolvedTenant {
  /** Normalized 0x-prefixed 40-hex wallet address used as the tenant key. */
  tenantId: string
  /**
   * True only when a Dynamic JWT was verified against the issuer's JWKS. False
   * when we fell back to shape-validating the body (booth-gated / local demo).
   */
  verified: boolean
}

/** A 0x-prefixed 40-hex wallet address (lowercased) check. */
function asWalletTenantId(raw: unknown): string {
  if (typeof raw !== 'string') throw new TenantAuthError()
  const id = raw.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(id)) throw new TenantAuthError()
  return id
}

/**
 * Resolve a tenant id from a parsed request body (the legacy/fallback shape
 * check, kept for back-compat). Accepts a `tenantId` that is a 0x-40-hex wallet
 * address (the Dynamic primary wallet), lowercased so it is a stable key.
 *
 * SEAM: prefer {@link resolveVerifiedTenant} on a request — it verifies a Dynamic
 * JWT first and only falls back to this when no issuer is configured.
 *
 * @param body - the parsed JSON request body.
 * @returns the normalized tenant id.
 * @throws {TenantAuthError} when no valid tenant id is present.
 */
export function resolveTenantId(body: unknown): string {
  const raw =
    body && typeof body === 'object' && 'tenantId' in body
      ? (body as { tenantId?: unknown }).tenantId
      : undefined
  return asWalletTenantId(raw)
}

/**
 * The Dynamic environment id (PUBLIC — `NEXT_PUBLIC_*`). When unset there is no
 * JWKS to verify against, so JWT verification is unavailable (fall back).
 */
function dynamicEnvironmentId(): string {
  return (process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? '').trim()
}

/** True when a Dynamic JWT can actually be verified (issuer/JWKS configured). */
export function isJwtVerificationConfigured(): boolean {
  return dynamicEnvironmentId().length > 0
}

/**
 * Dynamic's public JWKS endpoint for an environment (RS256 verification keys).
 * The URL is derived from the public environment id; no secret is involved.
 */
function dynamicJwksUrl(): URL {
  const env = dynamicEnvironmentId()
  // Dynamic serves the SDK JWKS at this well-known path per environment.
  return new URL(`https://app.dynamic.xyz/api/v0/sdk/${env}/.well-known/jwks`)
}

/**
 * The issuer (`iss`) a Dynamic JWT for THIS environment must carry (C-3). Dynamic
 * scopes every token to its environment id, so a token minted for a DIFFERENT
 * Dynamic environment/app has a different `iss` and must be rejected — pinning
 * this is what stops cross-environment forgery. The value is environment-derived
 * (Dynamic's documented `app.dynamicauth.com/{environmentId}` token issuer) with a
 * `DYNAMIC_JWT_ISSUER` override so a deployment can point at the exact issuer its
 * Dynamic dashboard reports without a code change. We never guess: when the env id
 * is unset there is nothing to pin (and JWT verification is unavailable anyway).
 *
 * @returns the expected issuer, or '' when no environment id is configured.
 */
function dynamicJwtIssuer(): string {
  const override = (process.env.DYNAMIC_JWT_ISSUER ?? '').trim()
  if (override.length > 0) return override
  const env = dynamicEnvironmentId()
  return env.length > 0 ? `app.dynamicauth.com/${env}` : ''
}

/**
 * The audience (`aud`) a Dynamic JWT must be issued FOR (C-3). Defaults to the
 * environment id (the app a Dynamic token is audienced to) with a
 * `DYNAMIC_JWT_AUDIENCE` override for deployments whose token format differs.
 * Pinning the audience rejects a token minted for some OTHER Dynamic app.
 *
 * @returns the expected audience, or '' when no environment id is configured.
 */
function dynamicJwtAudience(): string {
  const override = (process.env.DYNAMIC_JWT_AUDIENCE ?? '').trim()
  if (override.length > 0) return override
  return dynamicEnvironmentId()
}

// One remote JWKS per process (cached; jose handles key rotation + caching).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) jwks = createRemoteJWKSet(dynamicJwksUrl())
  return jwks
}

/**
 * Pull the verified wallet address out of a Dynamic JWT payload. Dynamic embeds
 * the signed-in wallets under `verified_credentials`; we take the first entry's
 * address. Shape is validated to a 0x-40-hex address or we refuse (no guessing).
 */
function walletFromClaims(payload: JWTPayload): string {
  const creds = (payload as { verified_credentials?: unknown }).verified_credentials
  if (Array.isArray(creds)) {
    for (const c of creds) {
      const addr =
        c && typeof c === 'object' && 'address' in c
          ? (c as { address?: unknown }).address
          : undefined
      if (typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr.trim())) {
        return addr.trim().toLowerCase()
      }
    }
  }
  throw new TenantAuthError('Your sign-in did not include a wallet — reconnect and try again.')
}

/** Extract a Bearer token from an Authorization header, or null. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : null
}

/**
 * Resolve the calling tenant for a tenant-scoped request, preferring a verified
 * Dynamic JWT over the body.
 *
 *  - If JWT verification IS configured and a Bearer token is present: verify the
 *    token against Dynamic's JWKS, derive the tenant id from the verified wallet
 *    claim, and reject when the body `tenantId` (if any) disagrees with it.
 *  - Otherwise (no issuer configured — booth-gated/local demo): fall back to the
 *    shape-validated body `tenantId`, returned with `verified: false`.
 *
 * @param request - the incoming request (for the Authorization header).
 * @param body    - the parsed JSON body (for the fallback / cross-check).
 * @returns the resolved tenant id + whether it was cryptographically verified.
 * @throws {TenantAuthError} on a missing/invalid/mismatched identity.
 */
export async function resolveVerifiedTenant(
  request: Request,
  body: unknown,
): Promise<ResolvedTenant> {
  const token = bearerToken(request)

  // Verified path: issuer configured AND a token was presented.
  if (isJwtVerificationConfigured() && token) {
    let payload: JWTPayload
    try {
      const result = await jwtVerify(token, getJwks(), {
        // C-3: pin the issuer + audience to THIS Dynamic environment/app so a
        // token minted for a DIFFERENT environment (a valid RS256 token whose
        // key is in some Dynamic JWKS) is rejected — not just any signed token.
        // `exp`/`nbf` are enforced by jwtVerify; `issuer`/`audience` are
        // environment-derived (with env overrides) so this stays config-driven.
        issuer: dynamicJwtIssuer(),
        audience: dynamicJwtAudience(),
      })
      payload = result.payload
    } catch {
      // A presented-but-invalid token is an auth failure (never fall through to
      // trusting the body — that would defeat the verification).
      throw new TenantAuthError('Your session is invalid or expired — sign in again.')
    }
    const verifiedTenant = walletFromClaims(payload)

    // Defense in depth: if the body also carries a tenantId it MUST match the
    // verified wallet (a client can't act for a wallet it didn't prove).
    const bodyRaw =
      body && typeof body === 'object' && 'tenantId' in body
        ? (body as { tenantId?: unknown }).tenantId
        : undefined
    if (typeof bodyRaw === 'string' && bodyRaw.trim() && asWalletTenantId(bodyRaw) !== verifiedTenant) {
      throw new TenantAuthError('Signed-in wallet does not match the requested tenant.')
    }
    return { tenantId: verifiedTenant, verified: true }
  }

  // Fallback: no issuer configured (booth-gated). Shape-validate the body so a
  // junk tenant id is still rejected, but mark it unverified.
  return { tenantId: resolveTenantId(body), verified: false }
}

/** Test-only: reset the cached JWKS so a fresh env takes effect. */
export function __resetTenantJwksForTests(): void {
  jwks = null
}
