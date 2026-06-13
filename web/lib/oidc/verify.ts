/**
 * verify.ts — verify an OIDC ID token ("Sign in with Google") server-side.
 *
 * The user signs in with an OIDC provider (Google by default, any OIDC issuer or
 * the operator's own backend by env) and the browser hands us the resulting ID
 * token (a signed JWT). This module verifies it the same way the Dynamic JWT path
 * does (`lib/branding/tenant.ts`): fetch the issuer's public JWKS with `jose`,
 * verify the RS256 signature, and pin the standard claims — `iss` (issuer) and
 * `aud` (audience = the configured client id) — so a token minted for some OTHER
 * app or issuer is rejected. `exp`/`nbf` are enforced by `jwtVerify`.
 *
 * VERIFY FOR ALL: a verified token identifies a USER (the `sub`, plus `email` for
 * display) and, when the token also carries an agent claim, a verified AGENT
 * acting on that user's behalf — both come back in the result so the caller can
 * record either or both.
 *
 * GENERIC: no vendor name appears here. The issuer / JWKS / audience all come from
 * `lib/oidc/config.ts` (env-configurable). When OIDC is not configured (no
 * audience) we return `not_configured` and NEVER fake a pass (law #4). This module
 * does the network verify + claim extraction ONLY; the route owns dedup + HTTP
 * status mapping, so it stays trivially unit-testable by mocking `jose`.
 *
 * It NEVER touches money, a payout address, or a private key — a pure verify call.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import {
  isOidcConfigured,
  oidcAgentClaim,
  oidcAudience,
  oidcIssuer,
  oidcJwksUrl,
} from './config.js'

/** The verified identity pulled off a valid OIDC ID token. */
export interface OidcIdentity {
  /** The provider's stable subject id (`sub`) — the user's unique key at the IdP. */
  subject: string
  /** The verified email, when the token carries one (display only, may be absent). */
  email: string | null
  /**
   * An agent id when the token carries the configured agent claim — "verify for
   * all" (a verified agent acting on the user's behalf). Null when absent.
   */
  agent: string | null
}

/** A successful verification. */
export interface OidcVerifyOk {
  ok: true
  identity: OidcIdentity
}

/** A failed verification — unconfigured, a bad token, or an unreachable JWKS. */
export interface OidcVerifyErr {
  ok: false
  /** A machine code the route maps to a status (never leaks a secret). */
  code: 'not_configured' | 'missing_token' | 'token_invalid' | 'jwks_unreachable'
}

export type OidcVerifyResult = OidcVerifyOk | OidcVerifyErr

// One remote JWKS per JWKS URL (cached; jose handles key rotation + HTTP caching).
// Keyed by URL so a re-pointed env in dev/tests gets a fresh set.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksByUrl.get(url)
  if (!set) {
    set = createRemoteJWKSet(new URL(url))
    jwksByUrl.set(url, set)
  }
  return set
}

/** Read a string claim off a payload, or null when absent/non-string. */
function stringClaim(payload: JWTPayload, key: string): string | null {
  const v = (payload as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

/**
 * Verify an OIDC ID token and return the verified user (+ optional agent).
 *
 *  - Returns `not_configured` when no audience (client id) is set — OIDC is off,
 *    fail-soft, never a faked pass.
 *  - Returns `missing_token` when no token string is supplied.
 *  - Verifies signature + `iss` + `aud` (+ exp/nbf) against the configured JWKS;
 *    a bad/expired/wrong-issuer/wrong-audience token ⇒ `token_invalid`.
 *  - A JWKS fetch/network failure ⇒ `jwks_unreachable` (fail-soft, not a forge).
 *
 * @param token - the raw OIDC ID token (a signed JWT) from the sign-in flow.
 * @returns the verified identity, or a machine error code.
 */
export async function verifyOidcToken(token: unknown): Promise<OidcVerifyResult> {
  if (!isOidcConfigured()) return { ok: false, code: 'not_configured' }
  if (typeof token !== 'string' || token.trim().length === 0) {
    return { ok: false, code: 'missing_token' }
  }

  let payload: JWTPayload
  try {
    const result = await jwtVerify(token.trim(), getJwks(oidcJwksUrl()), {
      issuer: oidcIssuer(),
      audience: oidcAudience(),
    })
    payload = result.payload
  } catch (err) {
    // jose throws a typed JWKS fetch error when the keys can't be retrieved — that
    // is "unreachable" (fail-soft), distinct from a token the issuer signed wrong.
    if (isJwksFetchError(err)) return { ok: false, code: 'jwks_unreachable' }
    // Signature / iss / aud / exp failures are an invalid token (never fall
    // through to trusting it — that would defeat the verification).
    return { ok: false, code: 'token_invalid' }
  }

  // A valid OIDC ID token always carries `sub`; without it we cannot key a user.
  const subject = stringClaim(payload, 'sub')
  if (!subject) return { ok: false, code: 'token_invalid' }

  return {
    ok: true,
    identity: {
      subject,
      email: stringClaim(payload, 'email'),
      // "verify for all": if the token carries the configured agent claim, the
      // agent is verified alongside the user.
      agent: stringClaim(payload, oidcAgentClaim()),
    },
  }
}

/**
 * Distinguish a JWKS retrieval failure (the keys could not be fetched — network /
 * 5xx) from a token-validation failure. jose tags the former `code:
 * 'ERR_JWKS_TIMEOUT'` / `'ERR_JWKS_NO_MATCHING_KEY'` and JOSE errors expose a
 * `code`; we treat fetch/timeout as unreachable so the route can fail soft.
 */
function isJwksFetchError(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : ''
  return code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JWKS_NO_MATCHING_KEY'
}

/** Test-only: drop the cached JWKS so a re-pointed env / mock takes effect. */
export function __resetOidcJwksForTests(): void {
  jwksByUrl.clear()
}
