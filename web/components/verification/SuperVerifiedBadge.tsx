'use client'

import type { ReactNode } from 'react'
import { Check, Circle, Sparkles } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { LEVEL_INFO, TIER_INFO, tierToLevel, type TrustTier } from '@/lib/verification/tiers'

/**
 * SuperVerifiedBadge — the visual rung a user has earned, now on shadcn/ui.
 *
 * Kept on its existing legacy {tier, score} API so existing consumers
 * (CheckoutCard, VerificationLadder) don't change. Internally it maps the legacy
 * TrustTier onto the 5-rung level ladder and renders the shadcn Badge:
 *   - super-verified -> the distinct gold/gradient shimmer `super` Badge.
 *   - verified       -> the green `success` Badge.
 *   - standard       -> the neutral `outline` Badge.
 * A Tooltip explains the rung. Plain-English copy; no jargon.
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
  const level = tierToLevel(tier)
  const variant = tier === 'super-verified' ? 'super' : tier === 'verified' ? 'success' : 'outline'
  const icon =
    tier === 'super-verified' ? (
      <Sparkles className="size-3" aria-hidden />
    ) : tier === 'verified' ? (
      <Check className="size-3" aria-hidden />
    ) : (
      <Circle className="size-3" aria-hidden />
    )

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={variant}
            data-tier={tier}
            aria-label={`${label}${typeof score === 'number' ? `, trust score ${score} of 100` : ''}`}
          >
            {icon}
            {label}
            {typeof score === 'number' ? (
              <span className="font-normal opacity-70">· {score}/100</span>
            ) : null}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{LEVEL_INFO[level].blurb}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
