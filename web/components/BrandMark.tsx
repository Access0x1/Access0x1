/**
 * BrandMark — the Access0x1 "0x1 access plug" mark + wordmark.
 *
 * The glyph draws the name as computer bits: 0 is a cyan socket ring holding
 * three teal web3 dots (the bit is OFF), x is the crossed connection that
 * flips it, and 1 is the teal pin (the bit lands ON). It says: wire web2 to
 * web3. It is the same glyph as web/public/access0x1-mark.svg, inlined as a
 * component so it inherits the brand fonts and never ships an extra request.
 *
 * Colours come straight from the brand chassis: cyan #22D3EE (--accent — the
 * socket + x, the structure) and teal #2DD4BF (--accent-2 — the three dots +
 * the pin, the web3 side). This is the DEFAULT Access0x1 chassis brand; a
 * per-merchant white-label still themes their own checkout via `brandColor`
 * (SlugCheckoutView / BrandPreview) — this mark is not used there.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** The cyan from the brand palette (--accent / the socket ring + x). */
const CYAN = '#22D3EE'
/** The teal from the brand palette (--accent-2 / the web3 dots + the pin). */
const TEAL = '#2DD4BF'

export interface BrandMarkProps {
  /** Show the "Access0x1" wordmark beside the glyph (default: true). */
  withWordmark?: boolean
  /** Pixel height of the glyph (the wordmark scales with it). Default 20. */
  size?: number
  /** Extra classes on the wrapping element. */
  className?: string
}

/** The access-plug glyph on its own — no wordmark, square. */
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
      {/* 0 — the socket ring (cyan structure) */}
      <circle cx="16" cy="32" r="11" fill="none" stroke={CYAN} strokeWidth="4" />
      {/* The three web3 dots held in the socket (teal) */}
      <circle cx="11.6" cy="29.4" r="2.3" fill={TEAL} />
      <circle cx="20.4" cy="29.4" r="2.3" fill={TEAL} />
      <circle cx="16" cy="37.6" r="2.3" fill={TEAL} />
      {/* x — the connection that flips the bit off → on (cyan) */}
      <path d="M28 23 L41 41 M41 23 L28 41" stroke={CYAN} strokeWidth="4" strokeLinecap="round" />
      {/* 1 — the pin: the bit lands ON (teal) */}
      <path d="M53 22 L53 42" stroke={TEAL} strokeWidth="4.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The full horizontal lockup: plug glyph + "Access0x1" wordmark. Defaults to
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
