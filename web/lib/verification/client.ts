'use client'

/**
 * client.ts — typed browser helpers for the Super Verification API.
 *
 * Thin `fetch` wrappers the VerificationLadder UI uses. They never throw on a
 * non-2xx; they return a discriminated result so the UI can show plain-English
 * copy (non-coder law). The server does every real check; the client only kicks
 * methods off and renders the derived profile/tier.
 */

import type { TrustTier, VerificationMethod } from './tiers'

/** The derived profile the API returns (methods + score + tier + next step). */
export interface VerificationProfileResponse {
  user: string
  methods: VerificationMethod[]
  score: number
  tier: TrustTier
  nextStep: string | null
}

/** Read a user's verification profile (or null on a transport error). */
export async function loadProfile(user: string): Promise<VerificationProfileResponse | null> {
  try {
    const res = await fetch(`/api/verify?user=${encodeURIComponent(user)}`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as VerificationProfileResponse
  } catch {
    return null
  }
}

/** Result of a verify attempt: the fresh profile, or a coded error for the UI. */
export type VerifyResult =
  | { ok: true; profile: VerificationProfileResponse }
  | { ok: false; error: string; code?: string }

/**
 * Submit one method's verification. `extra` carries the method-specific payload
 * the server re-checks: `{ proof, action }` for World ID, `{ ensName }` for ENS;
 * `dynamic` and `onchain` need no extra (the server reads the session / chain).
 */
export async function verifyMethod(
  user: string,
  method: VerificationMethod,
  extra?: Record<string, unknown>,
): Promise<VerifyResult> {
  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, method, ...extra }),
    })
    const json = (await res.json()) as VerificationProfileResponse & { error?: string }
    if (res.ok && !json.error) return { ok: true, profile: json }
    return { ok: false, error: json.error ?? 'verify_failed', code: json.error }
  } catch {
    return { ok: false, error: 'unreachable' }
  }
}
