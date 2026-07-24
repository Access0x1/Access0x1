/**
 * AnimatedBrandMark — the access-plug glyph, animated to tell its own story.
 *
 * The static {@link BrandGlyph} encodes a sentence: `0` is a socket ring holding
 * three web3 dots (the bit is OFF), `x` is the connection, `1` is the pin (the
 * bit lands ON). The animation simply plays that sentence in order — power
 * gathers in the socket, crosses the connection, and the pin lights. Nothing
 * decorative happens that the mark does not already mean.
 *
 * SELF-CONTAINED BY DESIGN: the keyframes live in a `<style>` inside the SVG, so
 * this component carries its own motion with no global CSS, no JS timer, and no
 * extra network request. Class names are prefixed `a0x1-` to avoid colliding
 * with a host page when the mark is embedded somewhere we do not control.
 *
 * ACCESSIBILITY: every animation is disabled under `prefers-reduced-motion`
 * (matching globals.css), leaving the mark in its fully-lit end state — never a
 * half-drawn frame. Motion is decorative here, so this costs the viewer nothing.
 * The `<title>` gives it an accessible name; decorative uses can pass their own.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** The cyan from the brand palette (--accent / the socket ring + x). */
const CYAN = '#22D3EE'
/** The teal from the brand palette (--accent-2 / the web3 dots + the pin). */
const TEAL = '#2DD4BF'

export interface AnimatedBrandMarkProps {
  /** Pixel height of the glyph. Default 64 — this mark rewards being seen. */
  size?: number
  /** Extra classes on the <svg>. */
  className?: string
  /** Accessible name. Pass `''` for a decorative instance beside real text. */
  title?: string
  /** Seconds for one full cycle. Default 3.2 — slow enough to read as intent. */
  duration?: number
}

/**
 * The animated access-plug glyph.
 *
 * @param size     Pixel height (square).
 * @param duration Seconds per loop; every keyframe is expressed as a percentage
 *                 of it, so the whole sequence retimes from this one number.
 */
export function AnimatedBrandGlyph({
  size = 64,
  className,
  title = 'Access0x1',
  duration = 3.2,
}: AnimatedBrandMarkProps): ReactNode {
  const decorative = title === ''
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role={decorative ? 'presentation' : 'img'}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative || undefined}
      className={cn('a0x1-mark', className)}
      xmlns="http://www.w3.org/2000/svg"
      style={{ ['--a0x1-dur' as string]: `${duration}s` }}
    >
      {!decorative && <title>{title}</title>}
      <style>{`
        /* The socket ring draws itself in, then holds. */
        .a0x1-ring { stroke-dasharray: 70; stroke-dashoffset: 70;
          animation: a0x1-draw var(--a0x1-dur) ease-out infinite; }
        /* The three dots wake in sequence — power gathering before it crosses. */
        .a0x1-dot { opacity: .3; animation: a0x1-wake var(--a0x1-dur) ease-in-out infinite; }
        .a0x1-dot-2 { animation-delay: calc(var(--a0x1-dur) * .05); }
        .a0x1-dot-3 { animation-delay: calc(var(--a0x1-dur) * .10); }
        /* The connection strokes on after the socket is live. */
        .a0x1-x { stroke-dasharray: 24; stroke-dashoffset: 24;
          animation: a0x1-draw var(--a0x1-dur) ease-out infinite;
          animation-delay: calc(var(--a0x1-dur) * .18); }
        /* The pin lands ON last — the whole point of the mark. */
        .a0x1-pin { opacity: .25; transform-origin: 53px 32px;
          animation: a0x1-land var(--a0x1-dur) ease-out infinite;
          animation-delay: calc(var(--a0x1-dur) * .38); }

        @keyframes a0x1-draw {
          0%   { stroke-dashoffset: var(--a0x1-from, 70); }
          28%, 100% { stroke-dashoffset: 0; }
        }
        @keyframes a0x1-wake {
          0%, 10%  { opacity: .3; }
          30%, 100% { opacity: 1; }
        }
        @keyframes a0x1-land {
          0%   { opacity: .25; transform: scaleY(.55); }
          55%  { opacity: 1;   transform: scaleY(1.12); }
          70%, 100% { opacity: 1; transform: scaleY(1); }
        }

        /* Motion is decorative — under reduced-motion show the finished mark. */
        @media (prefers-reduced-motion: reduce) {
          .a0x1-ring, .a0x1-dot, .a0x1-x, .a0x1-pin { animation: none; }
          .a0x1-ring, .a0x1-x { stroke-dashoffset: 0; }
          .a0x1-dot, .a0x1-pin { opacity: 1; transform: none; }
        }
      `}</style>

      {/* 0 — the socket ring (cyan structure) */}
      <circle
        className="a0x1-ring"
        cx="16"
        cy="32"
        r="11"
        fill="none"
        stroke={CYAN}
        strokeWidth="4"
      />
      {/* The three web3 dots held in the socket (teal) */}
      <circle className="a0x1-dot" cx="11.6" cy="29.4" r="2.3" fill={TEAL} />
      <circle className="a0x1-dot a0x1-dot-2" cx="20.4" cy="29.4" r="2.3" fill={TEAL} />
      <circle className="a0x1-dot a0x1-dot-3" cx="16" cy="37.6" r="2.3" fill={TEAL} />
      {/* x — the connection that flips the bit off → on (cyan) */}
      <path
        className="a0x1-x"
        style={{ ['--a0x1-from' as string]: '24' }}
        d="M28 23 L41 41 M41 23 L28 41"
        stroke={CYAN}
        strokeWidth="4"
        strokeLinecap="round"
      />
      {/* 1 — the pin: the bit lands ON (teal) */}
      <path
        className="a0x1-pin"
        d="M53 22 L53 42"
        stroke={TEAL}
        strokeWidth="4.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** The animated glyph plus the "Access0x1" wordmark, as a horizontal lockup. */
export function AnimatedBrandMark({
  size = 64,
  className,
  title,
  duration,
}: AnimatedBrandMarkProps): ReactNode {
  return (
    <span className={cn('inline-flex items-center gap-3 align-middle', className)}>
      {/* The wordmark supplies the accessible name, so the glyph is decorative. */}
      <AnimatedBrandGlyph size={size} title="" duration={duration} />
      <span
        className="font-display font-semibold tracking-tight text-foreground"
        style={{ fontSize: size * 0.42, lineHeight: 1 }}
      >
        {title ?? 'Access0x1'}
      </span>
    </span>
  )
}

export default AnimatedBrandMark
