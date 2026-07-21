/**
 * LandingCTA.tsx — the primary call-to-action for the marketing landing page.
 *
 * Server-renderable, no client JS. It deep-links to the onboarding flow
 * (`/onboard`) using the established CTA idiom in this codebase: a shadcn
 * `Button` with `asChild` wrapping a real `<a>` so the control is a genuine,
 * crawlable link (and keyboard/AT-accessible) while keeping button styling.
 *
 * Copy comes from the active locale dictionary (`cta` slice) so the CTA speaks
 * the visitor's language.
 */
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import type { Dictionary } from '@/lib/i18n/get-dictionary'

export interface LandingCTAProps {
  /** Localized CTA copy (dict.cta). */
  cta: Dictionary['cta']
  /** Extra classes on the wrapping element (e.g. spacing in a given section). */
  className?: string
}

export function LandingCTA({ cta, className }: LandingCTAProps): ReactNode {
  return (
    <div
      className={[
        'flex flex-col items-center gap-3 sm:flex-row sm:justify-center',
        className ?? '',
      ]
        .join(' ')
        .trim()}
    >
      {/* Primary: get your branded checkout link — straight into onboarding. */}
      <Button asChild size="lg" className="w-full sm:w-auto">
        <a href="/onboard">{cta.primary}</a>
      </Button>

      {/* Secondary: a low-commitment "learn more" into the Q&A assistant. */}
      <Button asChild variant="ghost" size="lg" className="w-full sm:w-auto">
        <a href="/ask">{cta.secondary}</a>
      </Button>
    </div>
  )
}

export default LandingCTA
