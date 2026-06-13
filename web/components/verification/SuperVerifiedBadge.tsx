'use client'

import type { ReactNode } from 'react'
import { TIER_INFO, type TrustTier } from '@/lib/verification/tiers'

/**
 * SuperVerifiedBadge — the visual rung a user has earned (Standard / Verified /
 * Super Verified). Plain-English, non-coder copy; no jargon. Super Verified is
 * the celebratory state; Verified is a quieter green; Standard is neutral.
 */
export function SuperVerifiedBadge({
  tier,
  score,
}: {
  tier: TrustTier
  /** Optional trust score (0-100) shown alongside the label. */
  score?: number
}): ReactNode {
  const label = TIER_INFO[tier].label
  const styles: Record<TrustTier, string> = {
    standard: 'border-neutral-300 bg-neutral-50 text-neutral-600',
    verified: 'border-green-300 bg-green-50 text-green-700',
    'super-verified': 'border-rail bg-rail/10 text-rail',
  }
  const mark = tier === 'super-verified' ? '★' : tier === 'verified' ? '✓' : '○'

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium ${styles[tier]}`}
      data-tier={tier}
      aria-label={`${label}${typeof score === 'number' ? `, trust score ${score} of 100` : ''}`}
    >
      <span aria-hidden>{mark}</span>
      {label}
      {typeof score === 'number' ? (
        <span className="text-xs font-normal opacity-70">· {score}/100</span>
      ) : null}
    </span>
  )
}
