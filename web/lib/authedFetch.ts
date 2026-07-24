'use client'

/**
 * authedFetch.ts — the ONE place browser write-clients get their Dynamic
 * session header.
 *
 * The server verifies tenant writes against the Dynamic JWT
 * (lib/branding/tenant.ts → resolveVerifiedTenantForWrite), and in production
 * `BRANDING_REQUIRE_VERIFIED_WRITES` defaults ON — an unauthenticated write is
 * REJECTED. The withdraw card already attaches the token
 * (components/GatewayBalanceCard.tsx); this helper centralizes that exact
 * pattern so every write client sends it too, instead of each one re-inventing
 * (or forgetting) the header.
 *
 * Honest behavior: when there is no Dynamic session, no header is sent — the
 * request degrades to the server's unverified path (dev-friendly), and the
 * server policy decides. The token is read per-call (never cached here) so a
 * refreshed session is always the one sent.
 */

import { getAuthToken } from '@dynamic-labs/sdk-react-core'

/**
 * JSON headers for a tenant write: content-type plus, when a Dynamic session
 * exists, its `authorization: Bearer <jwt>` — the exact header
 * lib/branding/tenant.ts verifies.
 *
 * @returns headers for a JSON POST, with the Bearer token when signed in.
 */
export function authedJsonHeaders(): Record<string, string> {
  const token = getAuthToken()
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}
