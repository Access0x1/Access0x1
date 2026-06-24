/**
 * LandingCTA.tsx — the primary call-to-action for the marketing landing page.
 *
 * Server-renderable, no client JS. It deep-links to the onboarding flow
 * (`/onboard`) using the established CTA idiom in this codebase: a shadcn
 * `Button` with `asChild` wrapping a real `<a>` so the control is a genuine,
 * crawlable link (and keyboard/AT-accessible) while keeping button styling.
 * The app links internally with plain `<a href>` (e.g. OnboardView → /dashboard)
 * rather than next/link, so we match that — it keeps the page fully static with
 * no client runtime.
 *
 * A secondary "ghost" link points at the AI Q&A assistant route (`/ask`) for
 * visitors who want to read before they commit; it is optional and styled to
 * recede behind the primary action.
 */
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

export interface LandingCTAProps {
  /** Extra classes on the wrapping element (e.g. spacing in a given section). */
  className?: string
}

export function LandingCTA({ className }: LandingCTAProps): ReactNode {
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
        <a href="/onboard">Get started — it&rsquo;s free</a>
      </Button>

      {/* Secondary: a low-commitment "learn more" into the Q&A assistant. */}
      <Button asChild variant="ghost" size="lg" className="w-full sm:w-auto">
        <a href="/ask">Ask how it works</a>
      </Button>
    </div>
  )
}

export default LandingCTA
