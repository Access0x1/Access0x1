import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@access0x1/web'
import { Check } from 'lucide-react'

// TooltipContent only renders portalled out of a Tooltip+Provider+Trigger —
// composed here per components/verification/VerificationLevels.tsx's method
// chips, which is also the real axis worth sweeping: content length, from a
// one-line blurb to the two-sentence casino disclosure. Forced open (Root's
// `defaultOpen`) since Radix only opens on hover.
export const Short = () => (
  <div style={{ paddingTop: 48 }}>
    <TooltipProvider delayDuration={150}>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Badge variant="success" data-method="onchain" data-verified>
            <Check className="size-3" aria-hidden />
            Real wallet
          </Badge>
        </TooltipTrigger>
        <TooltipContent>Your wallet is funded or has paid before — not a brand-new throwaway. (+10 trust)</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
)

export const Long = () => (
  <div style={{ paddingTop: 48 }}>
    <TooltipProvider delayDuration={150}>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Badge variant="success" aria-label="Verified Humans Only · World ID">
            Verified Humans Only · World ID
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          Every player verified as a unique real person with World ID proof-of-personhood — no
          bots, one account per person. World ID proves a unique human only; it is not a gambling
          licence, age check, or eligibility check.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
)
