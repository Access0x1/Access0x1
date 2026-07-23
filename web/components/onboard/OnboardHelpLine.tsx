import type { ReactNode } from 'react'

/**
 * OnboardHelpLine — the persistent, quiet human-fallback line shown on the
 * onboard fork chooser and the developer panel.
 *
 * Deliberately generic and address-free (no invented support email): it points
 * at the in-app docs assistant (`/docs`), a grounded Q&A over the repo docs that
 * serves both the non-technical and the developer visitor. It is a plain link so
 * it reads and focuses like any other, in both the dark chassis and a `.light`
 * island.
 */
export function OnboardHelpLine(): ReactNode {
  return (
    <p className="text-center text-sm text-muted-foreground">
      Questions? Ask the{' '}
      <a
        href="/docs"
        className="text-rail underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
      >
        docs assistant
      </a>{' '}
      — plain-English answers, no crypto experience needed.
    </p>
  )
}
