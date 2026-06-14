/**
 * badge.tsx — the shadcn/ui Badge (MIT, copy-in) + extra variants for the
 * verification ladder.
 *
 * Standard shadcn variants: default / secondary / destructive / outline.
 * Added for this app:
 *   - success    — a verified method chip (green).
 *   - level      — a generic level rung (neutral outline; the L0–L3 badge).
 *   - super      — the L4 "Super Verified" badge: a gold→amber gradient with a
 *                  subtle shimmer (the `.ax1-shimmer` sweep from globals.css).
 *
 * Everything composes through `cn`, so a caller can still override per use.
 */
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
        outline: 'text-foreground border-border',
        // A passed/verified method chip.
        success:
          'border-transparent bg-green-100 text-green-700',
        // A neutral level rung badge (L0–L3 currentLevel display).
        level: 'border-primary/30 bg-primary/10 text-primary',
        // The pinnacle: gold/amber gradient + shimmer. Distinct from every
        // other variant per the spec ("distinct gold/gradient Badge").
        super:
          'ax1-shimmer border-amber-300/60 bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 text-amber-900 shadow-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): React.ReactElement {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
