/**
 * callerBinding.ts — the shared anti-farm gate for trust methods that do NOT bind the
 * recorded badge to the caller's own wallet.
 *
 * `world-id`, `oidc`, and `onchain` each prove SOMETHING (a unique human, a provider
 * account, a funded/active address) but none proves the CALLER controls the `user`
 * wallet the badge is recorded against. Left open, a caller could farm those badges onto
 * an arbitrary wallet — and the trust tier gates trial pay + checkout modes, so it is a
 * reputation-integrity hole, not cosmetic. `ens` (the name must forward-resolve to
 * `user`) and `dynamic` (the session wallet IS `user`) bind themselves and don't need it.
 *
 * The gate is DEFINED ONCE here because the same `oidc` method is recorded by TWO routes
 * (`/api/verify` and the dedicated `/api/oidc/verify`); binding only one would leave the
 * other as a trivial bypass. In production (`requireVerifiedWrites`) it requires a
 * verified Dynamic session whose wallet IS `user` — the same fail-closed policy the
 * branding writes and the `dynamic` verify method use. Dev/booth (Dynamic unset) keeps
 * the open demo flow.
 */

import { requireVerifiedWrites, resolveVerifiedTenant, TenantAuthError } from '@/lib/branding/tenant'

/** The outcome of a caller-binding check. `ok:false` carries a route-mappable code/status. */
export type CallerBinding = { ok: true } | { ok: false; code: string; status: number }

/**
 * Require the CALLER to control `user` before a badge is recorded against it.
 *
 * @param request  The incoming request (its bearer token is the Dynamic session).
 * @param user     The normalized wallet key the badge would be recorded against.
 * @param bodyUser The RAW `user` off the body — passed as the tenantId so
 *   `resolveVerifiedTenant` cross-checks it against the verified wallet.
 * @returns `{ ok: true }` to proceed; otherwise a code/status to return.
 */
export async function requireCallerOwnsUser(
  request: Request,
  user: string,
  bodyUser: unknown,
): Promise<CallerBinding> {
  // Dev/booth: no verified-writes policy in force — keep the open flow.
  if (!requireVerifiedWrites()) return { ok: true }
  try {
    const { tenantId, verified } = await resolveVerifiedTenant(request, { tenantId: bodyUser })
    if (tenantId.toLowerCase() !== user.toLowerCase()) {
      return { ok: false, code: 'caller_mismatch', status: 401 }
    }
    if (!verified) {
      return { ok: false, code: 'unverified_caller', status: 401 }
    }
    return { ok: true }
  } catch (err) {
    if (err instanceof TenantAuthError) return { ok: false, code: 'unverified_caller', status: 401 }
    return { ok: false, code: 'caller_check_failed', status: 500 }
  }
}
