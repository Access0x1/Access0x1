import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@access0x1/web'
import { Check } from 'lucide-react'

// TooltipProvider's real job is sharing ONE delayDuration/skipDelayDuration
// group across several Tooltip instances — components/verification/
// VerificationLevels.tsx wraps the whole method-chip row in a single
// Provider, exactly like this. One chip is forced open (Tooltip's own
// `defaultOpen`) since Radix only opens on hover.
export const MethodRow = () => (
  <div style={{ paddingTop: 48 }}>
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-wrap gap-2">
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Badge variant="success" data-method="world-id" data-verified>
              <Check className="size-3" aria-hidden />
              World ID
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Proves you are a real, unique person — the strongest check. (+50 trust)
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="success" data-method="dynamic" data-verified>
              <Check className="size-3" aria-hidden />
              Signed in
            </Badge>
          </TooltipTrigger>
          <TooltipContent>You are signed in with an email, social, or wallet account. (+15 trust)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="cursor-default opacity-70" data-method="ens" data-verified={false}>
              ENS name
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Your wallet resolves to a human-readable ENS name — a real, named identity. (+25 trust)</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  </div>
)
