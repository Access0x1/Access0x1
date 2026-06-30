'use client'

/**
 * client.ts — typed browser helpers for the branding endpoints (ADR unit 2).
 *
 * Thin `fetch` wrappers the "Make it yours" screen + Settings → Branding card
 * use. They never throw on a non-2xx; they return a discriminated result so the
 * UI can show a plain-English message (non-coder law: no raw errors).
 */

import type { CheckoutMode, HumanVerifier, MerchantVertical, TenantBranding } from './store'
import type { TrustTier } from '../verification/tiers'

/** The tenant-facing branding row returned by GET/POST /api/branding. */
export type ClientBranding = TenantBranding

/**
 * Save the D0 "Who can pay you?" choice (World ID ADR D0). Rides on the same
 * branding row; requires the tenant to have saved their name/logo first (the
 * card is only shown after that), so a `no_branding` 400 is surfaced plainly.
 */
export async function saveCheckoutMode(input: {
  tenantId: string
  checkoutMode: CheckoutMode
  humanVerifier?: HumanVerifier
  /** Minimum buyer trust tier required to pay (Super Verification). */
  requiredTier?: TrustTier
  /**
   * The merchant's business category (Casino vertical). When 'casino', the
   * server forces verified-human AND blocks the save until the operator is
   * World ID-verified (surfaced as the `CASINO_NEEDS_OPERATOR` code below).
   */
  vertical?: MerchantVertical
}): Promise<{ ok: true; branding: ClientBranding } | { ok: false; error: string; code?: string }> {
  try {
    const res = await fetch('/api/branding/checkout-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const json = (await res.json()) as { branding?: ClientBranding; error?: string; code?: string }
    if (res.ok && json.branding) return { ok: true, branding: json.branding }
    if (json.error === 'no_branding') {
      return {
        ok: false,
        error: 'Set your business name first, then choose who can pay you.',
        code: 'no_branding',
      }
    }
    if (json.code === 'CASINO_NEEDS_OPERATOR') {
      return {
        ok: false,
        error:
          'Casinos must verify with World ID before going live. Complete the World ID step to prove a real person is running this casino.',
        code: 'CASINO_NEEDS_OPERATOR',
      }
    }
    return { ok: false, error: json.error ?? 'Could not save. Please try again.', code: json.code }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
}

/**
 * Bind an on-chain `merchantId` to the tenant's branding row so their checkout
 * slug becomes PAYABLE ("switch on payments"). Rides on the same branding row;
 * requires the tenant to have saved their name/logo first (the card is only
 * shown after that), so a `no_branding` 400 is surfaced plainly.
 *
 * Same discriminated-result shape as `saveBranding` / `saveCheckoutMode`: never
 * throws on a non-2xx; returns `{ ok }` so the UI shows a plain-English message.
 */
export async function attachOnChain(input: {
  tenantId: string
  merchantId: string
}): Promise<{ ok: true; branding: ClientBranding } | { ok: false; error: string; code?: string }> {
  try {
    const res = await fetch('/api/branding/attach-onchain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const json = (await res.json()) as { branding?: ClientBranding; error?: string; code?: string }
    if (res.ok && json.branding) return { ok: true, branding: json.branding }
    if (json.error === 'no_branding') {
      return {
        ok: false,
        error: 'Set your business name first, then switch on payments.',
        code: 'no_branding',
      }
    }
    return { ok: false, error: json.error ?? 'Could not switch on payments. Please try again.', code: json.code }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
}

/**
 * Record the operator's World ID proof on their branding row (Casino vertical).
 * The `WorldIdGate` is pointed at `/api/branding/operator-verify` with the
 * operator action; on a 200 the row's `verifiedOperator` flips true so a casino
 * can be saved. This helper is only the result reader — the gate does the POST.
 */
export async function loadOperatorVerified(tenantId: string): Promise<boolean> {
  const row = await loadBranding(tenantId)
  return row?.verifiedOperator === true
}

/** Save (or edit) the tenant's branding. */
export async function saveBranding(input: {
  tenantId: string
  displayName: string
  description?: string
  brandColor?: string
  checkoutSlug?: string
  logoSvgInline?: string
}): Promise<{ ok: true; branding: ClientBranding } | { ok: false; error: string; code?: string }> {
  try {
    const res = await fetch('/api/branding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const json = (await res.json()) as { branding?: ClientBranding; error?: string; code?: string }
    if (res.ok && json.branding) return { ok: true, branding: json.branding }
    return { ok: false, error: json.error ?? 'Could not save. Please try again.', code: json.code }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
}

/** Read the tenant's own branding (prefill the edit card). */
export async function loadBranding(tenantId: string): Promise<ClientBranding | null> {
  try {
    const res = await fetch(`/api/branding?tenantId=${encodeURIComponent(tenantId)}`)
    if (!res.ok) return null
    const json = (await res.json()) as { branding: ClientBranding | null }
    return json.branding
  } catch {
    return null
  }
}

/** Check whether a checkout-link tail is available (debounced by the caller). */
export async function checkSlug(
  slug: string,
  tenantId?: string,
): Promise<{ valid: boolean; available: boolean; normalized: string; suggestions: string[] }> {
  try {
    const qs = new URLSearchParams({ slug })
    if (tenantId) qs.set('tenantId', tenantId)
    const res = await fetch(`/api/branding/check-slug?${qs.toString()}`)
    if (!res.ok) return { valid: false, available: false, normalized: '', suggestions: [] }
    return (await res.json()) as {
      valid: boolean
      available: boolean
      normalized: string
      suggestions: string[]
    }
  } catch {
    return { valid: false, available: false, normalized: '', suggestions: [] }
  }
}

/** Sanitize + convert an uploaded logo (SVG markup or a raster data-URI). */
export async function uploadLogo(
  tenantId: string,
  logo: string,
): Promise<{ ok: true; logoSvgInline: string } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/branding/logo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId, logo }),
    })
    const json = (await res.json()) as { logoSvgInline?: string; error?: string }
    if (res.ok && json.logoSvgInline) return { ok: true, logoSvgInline: json.logoSvgInline }
    return { ok: false, error: json.error ?? 'That logo could not be used. Try a PNG or SVG.' }
  } catch {
    return { ok: false, error: 'Could not upload the logo. Please try again.' }
  }
}

/** Read a file the customer dropped in as a data-URI string (for raster logos). */
export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read the file.'))
    reader.readAsDataURL(file)
  })
}
