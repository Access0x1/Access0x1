/**
 * BrandMark — the Access0x1 "bridge" mark + wordmark.
 *
 * The glyph is two cyan pylons joined by a top span broken in the centre (the
 * crossing / void — it reads as a bridge, a rotated H, and the "0x1" in the
 * name), grounded by an unbroken teal base rail (the settled layer). It is the
 * same glyph as brand-assets/access0x1/access0x1-mark.svg, inlined as a
 * component so it inherits the brand fonts and never ships an extra request.
 *
 * Colours come straight from the brand chassis: cyan #22D3EE (--accent / the
 * lit path) and teal #2DD4BF (--accent-2). This is the DEFAULT Access0x1
 * chassis brand; a per-merchant white-label still themes their own checkout via
 * `brandColor` (SlugCheckoutView / BrandPreview) — this mark is not used there.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** The cyan from the brand palette (--accent / "the lit path"). */
const CYAN = '#22D3EE'
/** The teal from the brand palette (--accent-2 / the settled base rail). */
const TEAL = '#2DD4BF'

export interface BrandMarkProps {
  /** Show the "Access0x1" wordmark beside the glyph (default: true). */
  withWordmark?: boolean
  /** Pixel height of the glyph (the wordmark scales with it). Default 20. */
  size?: number
  /** Extra classes on the wrapping element. */
  className?: string
}

/** The bridge glyph on its own — no wordmark, square. */
export function BrandGlyph({
  size = 20,
  className,
  title = 'Access0x1',
}: {
  size?: number
  className?: string
  title?: string
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label={title}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      {/* Left pylon */}
      <rect x="6" y="16" width="12" height="42" rx="3" fill={CYAN} />
      {/* Right pylon */}
      <rect x="46" y="16" width="12" height="42" rx="3" fill={CYAN} />
      {/* Top span — broken in the centre (the void / gap) */}
      <rect x="6" y="6" width="22" height="12" rx="3" fill={CYAN} />
      <rect x="36" y="6" width="22" height="12" rx="3" fill={CYAN} />
      {/* Base rail — teal, unbroken: the ground / settled layer */}
      <rect x="6" y="54" width="52" height="4" rx="2" fill={TEAL} />
    </svg>
  )
}

/**
 * The full horizontal lockup: bridge glyph + "Access0x1" wordmark. Defaults to
 * a compact size suited to a header or a footer "Powered by" line.
 */
export function BrandMark({
  withWordmark = true,
  size = 20,
  className,
}: BrandMarkProps): ReactNode {
  return (
    <span className={cn('inline-flex items-center gap-2 align-middle', className)}>
      <BrandGlyph size={size} />
      {withWordmark ? (
        <span
          className="font-display font-semibold tracking-tight text-foreground"
          style={{ fontSize: size * 0.9, lineHeight: 1 }}
        >
          Access0x1
        </span>
      ) : null}
    </span>
  )
}

export default BrandMark
