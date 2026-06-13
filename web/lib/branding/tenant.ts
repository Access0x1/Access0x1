/**
 * tenant.ts — resolve the calling tenant id for a branding WRITE (ADR D1/D2).
 *
 * A tenant is identified by their Dynamic sign-in. In this hosted-demo build the
 * client sends its Dynamic-authenticated wallet address as the tenant id; we
 * validate its shape and normalize it. This is the SEAM where a production build
 * verifies a Dynamic JWT server-side (the repo already has the
 * `authenticateApiToken` precedent in `lib/agent/dynamicAgentWallet.ts`) and
 * derives the tenant id from the verified claim instead of trusting the body.
 *
 * The PUBLIC read endpoints need none of this — they are read-only by slug /
 * merchant id. Only the writes (Save, logo upload) resolve a tenant.
 */

/** Thrown when a write request carries no usable tenant identity. */
export class TenantAuthError extends Error {
  constructor(message = 'Sign in to save your branding.') {
    super(message)
    this.name = 'TenantAuthError'
  }
}

/**
 * Resolve a tenant id from a parsed request body.
 *
 * Today: accepts a `tenantId` that is a 0x-prefixed 40-hex wallet address (the
 * Dynamic primary wallet), lowercased so it is a stable key. Rejects anything
 * else loudly — we never key a branding row off junk.
 *
 * SEAM: replace the body read with a verified-JWT claim read for production.
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
  if (typeof raw !== 'string') throw new TenantAuthError()
  const id = raw.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(id)) throw new TenantAuthError()
  return id
}
