'use client'

/**
 * client.ts — typed browser helpers for the branding endpoints (ADR unit 2).
 *
 * Thin `fetch` wrappers the "Make it yours" screen + Settings → Branding card
 * use. They never throw on a non-2xx; they return a discriminated result so the
 * UI can show a plain-English message (non-coder law: no raw errors).
 */

import type { CheckoutMode, HumanVerifier, TenantBranding } from './store'
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
    return { ok: false, error: json.error ?? 'Could not save. Please try again.', code: json.code }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
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
