import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * SectionCard — the shared card container for the merchant surfaces.
 *
 * The five merchant pages each wrote `rounded-2xl border border-... p-6` by hand
 * with drifting borders (border-neutral-200 vs border-border) and no consistent
 * surface. This is the one rounded-2xl bordered card on the chassis `bg-card`
 * surface, so every merchant panel shares one shape, radius, and padding.
 *
 * It is a thin, transparent wrapper: `className` composes through `cn` so a page
 * can still tune spacing or override the surface (e.g. the rail-tinted
 * "Switch on payments" card) without forking the primitive.
 */
export function SectionCard({
  children,
  className,
  ...rest
}: {
  children: ReactNode
  className?: string
} & React.HTMLAttributes<HTMLElement>): ReactNode {
  return (
    <section className={cn('rounded-2xl border border-border bg-card p-6', className)} {...rest}>
      {children}
    </section>
  )
}
