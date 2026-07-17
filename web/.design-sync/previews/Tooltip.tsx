import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@access0x1/web'
import { ShieldCheck } from 'lucide-react'

// Tooltip (Radix's Root) only means anything composed with Provider+Trigger+
// Content — the real shape from components/CasinoVerifiedBadge.tsx. Radix
// opens on hover, which a static shot can't trigger, so the second cell forces
// it with the Root's own `defaultOpen` prop (no fork needed).
export const Closed = () => (
  <TooltipProvider delayDuration={150}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="success" aria-label="Verified Humans Only · World ID">
          <ShieldCheck className="size-3" aria-hidden />
          Verified Humans Only · World ID
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        Every player verified as a unique real person with World ID proof-of-personhood — no bots,
        one account per person.
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

export const Open = () => (
  <div style={{ paddingTop: 48 }}>
    <TooltipProvider delayDuration={150}>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Badge variant="success" aria-label="Verified Humans Only · World ID">
            <ShieldCheck className="size-3" aria-hidden />
            Verified Humans Only · World ID
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          Every player verified as a unique real person with World ID proof-of-personhood — no
          bots, one account per person.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
)
