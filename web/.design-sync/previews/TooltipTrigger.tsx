import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@access0x1/web'
import { Sparkles } from 'lucide-react'

// TooltipTrigger only renders meaningfully as the `asChild` wrapper around a
// real trigger element inside Tooltip+Provider+Content — shown here in its
// two real shapes: components/CasinoVerifiedBadge.tsx wraps the Badge
// directly, components/verification/VerificationLevels.tsx's LevelBadge wraps
// it in an extra <span> first. Forced open (Root's `defaultOpen`) since Radix
// only opens on hover.
export const BadgeChild = () => (
  <div style={{ paddingTop: 48 }}>
    <TooltipProvider delayDuration={150}>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Badge variant="super" aria-label="Super Verified — level 4 of 4">
            <Sparkles className="size-3" aria-hidden />
            Super Verified
          </Badge>
        </TooltipTrigger>
        <TooltipContent>The pinnacle: every check complete, finished with the World ID scan.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
)

export const SpanWrappedChild = () => (
  <div style={{ paddingTop: 48 }}>
    <TooltipProvider delayDuration={150}>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Badge variant="level" data-level={2} aria-label="Verified — level 2 of 4">
              Verified
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent>One strong proof in hand — a verified entity.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
)
