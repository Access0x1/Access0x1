'use client'

import type { ReactNode } from 'react'
import { Check, ShieldCheck, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  LEVEL_INFO,
  METHOD_INFO,
  METHOD_WEIGHTS,
  VERIFICATION_METHODS,
  levelFor,
  missingNonWorldMethods,
  type VerificationLevel,
  type VerificationMethod,
} from '@/lib/verification/tiers'

/**
 * VerificationLevels — the shadcn/ui verification panel (verification-levels ADR).
 *
 * Renders the 5-rung ladder for a (score, methods) profile, for people AND
 * agents:
 *   - a Card container;
 *   - a Progress trust meter (0–100), colour-shifting by level;
 *   - a row of method Badges (a check icon + success styling when verified, each
 *     with a Tooltip explaining what it proves);
 *   - the current Level Badge (the L4 "Super Verified" rung is the distinct
 *     gold/gradient shimmer Badge);
 *   - a "Verify more → reach <next level>" Button that links to the single
 *     highest-value next method.
 *
 * PRESENTATIONAL: it takes the methods + score and renders; it never calls the
 * network. The container (VerificationStack / CheckoutCard) owns the data and
 * the per-method actions. Off the money path by construction.
 */
export interface VerificationLevelsProps {
  /** The methods this profile has genuinely passed. */
  methods: readonly VerificationMethod[]
  /** The trust score (0–100). When omitted it's derived from `methods`. */
  score?: number
  /** Where the "Verify more" CTA points (default the verification page). */
  verifyHref?: string
  /** Optional click handler for the highest-value next method (in-page flows). */
  onVerifyMore?: (method: VerificationMethod) => void
  /** Optional extra classes for the Card. */
  className?: string
}

/** The Progress indicator colour per level (neutral → indigo → gold). */
const LEVEL_INDICATOR: Record<VerificationLevel, string> = {
  0: 'bg-muted-foreground/40',
  1: 'bg-sky-400',
  2: 'bg-primary',
  3: 'bg-violet-500',
  4: 'bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-400',
}

export function VerificationLevels({
  methods,
  score,
  verifyHref = '/verify',
  onVerifyMore,
  className,
}: VerificationLevelsProps): ReactNode {
  const { level, name, nextNeed } = levelFor(score ?? methodsToScore(methods), methods)
  const trustScore = score ?? methodsToScore(methods)
  const isSuper = level === 4

  // The CTA target: cheaper, non-World checks first — World ID is the FINAL
  // capstone, suggested only when it's the sole method left.
  const nextMethod = nextCtaMethod(methods)
  // When World ID is all that remains, the journey ENDS on the World scan.
  const finishWithWorld = nextMethod === 'world-id'
  const ctaLabel = finishWithWorld ? 'Finish with World' : 'Verify more'

  return (
    <TooltipProvider delayDuration={150}>
      <Card className={cn('w-full', className)}>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-primary" aria-hidden />
            Your verification
          </CardTitle>
          <LevelBadge level={level} name={name} />
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {/* Trust meter — colour by level. */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Trust score</span>
              <span className="font-medium text-foreground">{trustScore}/100</span>
            </div>
            <Progress
              value={trustScore}
              indicatorClassName={LEVEL_INDICATOR[level]}
              aria-label={`Trust score ${trustScore} of 100 — ${name}`}
            />
          </div>

          {/* Method chips: a check + success styling when verified, each with a
              Tooltip explaining what it proves. */}
          <div className="flex flex-wrap gap-2">
            {VERIFICATION_METHODS.map((method) => {
              const verified = methods.includes(method)
              const info = METHOD_INFO[method]
              return (
                <Tooltip key={method}>
                  <TooltipTrigger asChild>
                    <Badge
                      variant={verified ? 'success' : 'outline'}
                      className={cn('cursor-default', !verified && 'opacity-70')}
                      data-method={method}
                      data-verified={verified}
                    >
                      {verified ? <Check className="size-3" aria-hidden /> : null}
                      {info.label}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    {info.adds} (+{METHOD_WEIGHTS[method]} trust)
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>

          {/* Next step + CTA, or the celebratory L4 line. */}
          {isSuper ? (
            <p className="flex items-center gap-1.5 text-sm font-medium text-amber-600">
              <Sparkles className="size-4" aria-hidden />
              You&apos;re Super Verified — the highest trust level.
            </p>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">{nextNeed}</p>
              {nextMethod ? (
                onVerifyMore ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onVerifyMore(nextMethod)}
                    className="shrink-0"
                  >
                    {ctaLabel}
                  </Button>
                ) : (
                  <Button asChild size="sm" className="shrink-0">
                    <a href={verifyHref}>{ctaLabel}</a>
                  </Button>
                )
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  )
}

/**
 * The current-level Badge. L0–L3 use the neutral `level` variant; L4 Super
 * Verified is the distinct gold/gradient shimmer Badge, with a Tooltip.
 */
export function LevelBadge({
  level,
  name,
}: {
  level: VerificationLevel
  name: string
}): ReactNode {
  const blurb = LEVEL_INFO[level].blurb
  const badge =
    level === 4 ? (
      <Badge variant="super" data-level={level} aria-label={`${name} — level ${level} of 4`}>
        <Sparkles className="size-3" aria-hidden />
        {name}
      </Badge>
    ) : (
      <Badge variant="level" data-level={level} aria-label={`${name} — level ${level} of 4`}>
        {name}
      </Badge>
    )

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{badge}</span>
        </TooltipTrigger>
        <TooltipContent>{blurb}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Local score helper (mirrors computeTrustScore without importing the profile shape). */
function methodsToScore(methods: readonly VerificationMethod[]): number {
  const seen = new Set<VerificationMethod>()
  let raw = 0
  for (const m of methods) {
    if (!seen.has(m) && m in METHOD_WEIGHTS) {
      seen.add(m)
      raw += METHOD_WEIGHTS[m]
    }
  }
  return Math.min(100, raw)
}

/**
 * The CTA target method. World ID is the FINAL capstone, so we prefer the
 * highest-weight NON-World category still missing (category-aware via the shared
 * {@link missingNonWorldMethods}); World ID is returned only when it is the SOLE
 * remaining method (so the journey ends on the World scan).
 */
function nextCtaMethod(
  methods: readonly VerificationMethod[],
): VerificationMethod | null {
  const missingOthers = missingNonWorldMethods(methods)
  if (missingOthers.length > 0) return missingOthers[0]
  // Every other category is done — finish with World ID if it's still missing.
  if (!methods.includes('world-id')) return 'world-id'
  return null
}
