/**
 * config.ts — the OIDC ("Sign in with Google") env seam.
 *
 * One place reads the OIDC verification settings, so pointing an installer at a
 * different identity provider (Google, any OpenID Connect issuer, or the
 * operator's own auth backend) is an ENV change, never a code change. Mirrors how
 * World ID is isolated in `lib/worldid/config.ts` and Dynamic in
 * `lib/branding/tenant.ts`: nothing here is a branded constant — every value is
 * read from env with safe, honest fallbacks.
 *
 * GENERIC BY DESIGN: this module never names a vendor in code. The DEFAULTS point
 * at the public Google OIDC discovery values because "Sign in with Google" is the
 * out-of-the-box method, but an installer overrides every one of them via env to
 * verify against ANY OIDC provider (Auth0, Okta, Keycloak, a self-hosted issuer,
 * or the operator's own backend). The issuer + JWKS URL + audience together pin
 * exactly which provider's tokens are trusted.
 *
 * Honesty (law #4): when the audience (`NEXT_PUBLIC_OIDC_CLIENT_ID` /
 * `OIDC_AUDIENCE`) is unset, OIDC verification is treated as UNCONFIGURED and the
 * route fails soft (`not_configured`) rather than accepting an unaudienced token —
 * we never claim "verified" against a token we cannot fully pin.
 */

/**
 * Google's public OIDC issuer. Used as the DEFAULT issuer so "Sign in with
 * Google" works out of the box; override with `OIDC_ISSUER` for any other
 * provider. This is a public, well-known standards value, not a tenant secret.
 */
export const DEFAULT_OIDC_ISSUER = 'https://accounts.google.com'

/**
 * Google's public JWKS (RS256 signing keys) endpoint, the DEFAULT used to verify
 * an ID token's signature. Override with `OIDC_JWKS_URL` for any other provider.
 * No secret is involved — a JWKS is public verification material.
 */
export const DEFAULT_OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

/**
 * The OIDC issuer the ID token's `iss` claim must match. Defaults to the Google
 * issuer; override per deployment via `OIDC_ISSUER` to trust a different provider
 * (or the operator's own backend).
 */
export function oidcIssuer(): string {
  const v = (process.env.OIDC_ISSUER ?? '').trim()
  return v.length > 0 ? v : DEFAULT_OIDC_ISSUER
}

/**
 * The JWKS URL used to fetch the issuer's public signing keys. Defaults to the
 * Google certs endpoint; override via `OIDC_JWKS_URL` for any other provider.
 */
export function oidcJwksUrl(): string {
  const v = (process.env.OIDC_JWKS_URL ?? '').trim()
  return v.length > 0 ? v : DEFAULT_OIDC_JWKS_URL
}

/**
 * The expected token AUDIENCE — the OIDC client id the token was issued FOR.
 * Read from the public `NEXT_PUBLIC_OIDC_CLIENT_ID` (the same id the browser uses
 * to start the Sign-in-with-Google flow) with `OIDC_AUDIENCE` as a server-side
 * override. Returns '' when neither is set (⇒ OIDC is unconfigured / fail-soft).
 *
 * There is NO hardcoded default here on purpose: a client id is deployment-
 * specific, and pinning the audience is what stops a token minted for some OTHER
 * app from being accepted here. No audience ⇒ we honestly report not_configured.
 */
export function oidcAudience(): string {
  const override = (process.env.OIDC_AUDIENCE ?? '').trim()
  if (override.length > 0) return override
  return (process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? '').trim()
}

/**
 * True only when OIDC verification can be performed for real: an audience
 * (client id) is configured to pin the token to THIS app. The issuer + JWKS URL
 * always have safe public defaults, so the audience is the single gate.
 *
 * When false, the route fails soft with `not_configured` (booth-gated / pre-setup
 * state), exactly like World ID degrading to "standard" when its app id is blank.
 */
export function isOidcConfigured(): boolean {
  return oidcAudience().length > 0
}

/**
 * The token claim that, when present, names an AGENT acting on the user's behalf
 * — "verify for all" (a verified USER and, if the token carries it, a verified
 * AGENT). Configurable so a provider/backend that uses a different claim name can
 * point at it without code changes; defaults to a readable `agent_id`.
 */
export function oidcAgentClaim(): string {
  const v = (process.env.OIDC_AGENT_CLAIM ?? '').trim()
  return v.length > 0 ? v : 'agent_id'
}

/**
 * A one-line, honest "configure me" note for logs / a health endpoint. Names the
 * env vars an installer sets to turn OIDC verify-for-all on — never a vendor.
 */
export const OIDC_CONFIGURE_NOTE =
  'Set NEXT_PUBLIC_OIDC_CLIENT_ID (audience) to enable OIDC verify-for-all; ' +
  'override OIDC_ISSUER / OIDC_JWKS_URL / OIDC_AUDIENCE to use any OIDC provider ' +
  'or your own auth backend. Defaults verify Sign-in-with-Google ID tokens.'
