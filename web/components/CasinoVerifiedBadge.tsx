'use client'

import type { ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  CASINO_BADGE_DETAIL,
  CASINO_BADGE_TITLE,
  CASINO_BADGE_UNCONFIGURED,
  canShowCasinoBadge,
} from '@/lib/branding/casinoBadge'
import type { CheckoutMode } from '@/lib/branding/store'

/**
 * CasinoVerifiedBadge — the "Verified Humans Only · World ID" chip shown on a
 * casino's checkout + merchant card (Casino vertical, World prize).
 *
 * It renders the green badge ONLY when both gate conditions hold AND World ID is
 * configured (see {@link canShowCasinoBadge}). Truth-in-copy (law #4): the
 * tooltip states exactly what World ID proves — a unique real person, no bots,
 * one account per person — and EXPLICITLY says it is NOT a gambling licence, age
 * check, or eligibility check.
 *
 * Fail-soft: when `vertical === 'casino'` but World ID is unconfigured, it shows
 * the honest "World ID required — configure to verify" line instead of the badge
 * — it NEVER fakes the green check. Outside a casino (or when the conditions
 * don't hold) it renders nothing, exactly like FundButton when unconfigured.
 *
 * Pure from props (no effects, no network) so it is deterministically
 * SSR-testable, mirroring SuperVerifiedBadge / MerchantIdentityView.
 */
export function CasinoVerifiedBadge({
  verifiedOperator,
  checkoutMode,
  vertical,
  worldConfigured,
}: {
  /** True once the operator completed World ID proof-of-personhood. */
  verifiedOperator: boolean
  /** The merchant's checkout mode — must be 'verified-human' to issue the badge. */
  checkoutMode: CheckoutMode
  /** The merchant's vertical — controls the casino-specific unconfigured note. */
  vertical?: string | null
  /** Whether World ID is configured (injectable; defaults to the live env check). */
  worldConfigured?: boolean
}): ReactNode {
  const show = canShowCasinoBadge({ verifiedOperator, checkoutMode }, worldConfigured)

  if (show) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="success"
              data-casino-badge="verified"
              aria-label={CASINO_BADGE_TITLE}
            >
              <ShieldCheck className="size-3" aria-hidden />
              {CASINO_BADGE_TITLE}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{CASINO_BADGE_DETAIL}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  // Fail-soft for a casino that wants the badge but World ID isn't switched on:
  // tell the truth, never fake the green check.
  if (vertical === 'casino' && worldConfigured === false) {
    return (
      <p data-casino-badge="unconfigured" className="text-xs text-amber-700">
        {CASINO_BADGE_UNCONFIGURED}
      </p>
    )
  }

  // Conditions not met (and not the casino-unconfigured case) → render nothing.
  return null
}
