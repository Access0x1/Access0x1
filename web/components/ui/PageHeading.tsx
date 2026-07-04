import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * PageHeading — the shared page-title grammar for the merchant surfaces.
 *
 * The five merchant pages (onboard, verify, dashboard, settings/branding,
 * settings/checkout) each hand-rolled their own header: some with an uppercase
 * "eyebrow" line, some without, some `font-display`, some not. This is the one
 * primitive so they read as one product: an optional eyebrow in the cyan rail,
 * then a display-font heading in the chassis foreground.
 *
 * It renders only the title block; the page keeps its own header row (e.g. the
 * ConnectButton / IdentityChip on the right).
 */
export function PageHeading({
  eyebrow,
  title,
  className,
}: {
  /** Optional uppercase kicker above the title (e.g. "Settings · Branding"). */
  eyebrow?: ReactNode
  title: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {eyebrow ? (
        <p className="text-xs font-medium uppercase tracking-widest text-rail">{eyebrow}</p>
      ) : null}
      <h1 className="font-display text-2xl font-semibold text-foreground">{title}</h1>
    </div>
  )
}
