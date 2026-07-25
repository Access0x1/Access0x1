/**
 * Calcada.tsx — the Lisbon calçada design layer for the marketing landing.
 *
 * Inspired by the calçada portuguesa of Avenida da Liberdade: hand-set limestone
 * fields with basalt ornaments. One medallion there is — a century early — the
 * Access0x1 mark itself: a stone ring with orbiting dots and long curled
 * volutes, a decentralized network laid in basalt. This file draws that
 * medallion as vectors and reuses the BRAND GLYPH geometry (socket ring + three
 * dots) as its heart, so the pavement motif and the logo are literally one shape.
 *
 * Design rules:
 *  - Pure SVG + CSS, zero images, zero client JS — server-renderable, decorative
 *    only (`aria-hidden`, pointer-events-none). No copy, so nothing to localize.
 *  - Theme-aware by construction: everything is drawn in `currentColor` at low
 *    opacities on the `text-foreground` chassis — basalt-on-limestone in light
 *    mode, limestone-on-ink in dark. No new tokens.
 *  - The stone texture is an feTurbulence displacement (hand-cut edges) + a
 *    deterministic cobble pattern — same output on server and client, so there
 *    is no hydration drift.
 *  - Animation is CSS-only (orbit, draw-in via pathLength=1, slow drift) and
 *    every class no-ops under prefers-reduced-motion (see globals.css).
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** Shared defs: the stone-edge filter + the cobble field pattern + fade mask. */
function CalcadaDefs({
  idPrefix,
  stoneScale = 7,
}: {
  idPrefix: string
  /**
   * Displacement strength of the chisel filter, in LOCAL viewBox units — it
   * must scale with the geometry it roughens. 7 is calibrated for the hero's
   * 1200-unit canvas (24-unit strokes read as hand-cut); a small canvas like
   * the 120-unit medallion roundel needs ~2.5 or the jitter shreds the shapes
   * into fuzz instead of chiseling their edges.
   */
  stoneScale?: number
}): ReactNode {
  return (
    <defs>
      {/* Hand-cut basalt: jitter the vector edges like chiseled stone. */}
      <filter id={`${idPrefix}-stone`} x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale={stoneScale} />
      </filter>

      {/* The limestone field: offset cobbles, slightly rotated like a fan course. */}
      <pattern
        id={`${idPrefix}-field`}
        width="28"
        height="28"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(8)"
      >
        <rect x="1" y="1" width="12" height="11" rx="2" fill="currentColor" />
        <rect x="15" y="2" width="11" height="10" rx="2" fill="currentColor" />
        <rect x="2" y="15" width="10" height="11" rx="2" fill="currentColor" />
        <rect x="14" y="14" width="12" height="12" rx="2" fill="currentColor" />
      </pattern>

      {/* Vignette so the field fades out toward the edges (laid, not tiled).
          Biased LOW (cy 68%) so the cobbles read as ground under the copy and
          thin out toward the sky — a pavement, not wallpaper: the field meets
          the moonlight band at the fold's bottom and fades upward. */}
      <radialGradient id={`${idPrefix}-fade`} cx="50%" cy="68%" r="70%">
        <stop offset="0%" stopColor="white" stopOpacity="1" />
        <stop offset="70%" stopColor="white" stopOpacity="0.55" />
        <stop offset="100%" stopColor="white" stopOpacity="0" />
      </radialGradient>
      <mask id={`${idPrefix}-mask`}>
        <rect width="100%" height="100%" fill={`url(#${idPrefix}-fade)`} />
      </mask>
    </defs>
  )
}

/**
 * The full-bleed hero backdrop: the cobble field + the IMG_0025 medallion —
 * the brand ring with its three dots, orbiting satellites, long curled volutes
 * left and right, and the trailing dot column beneath. Decorative only.
 */
export function CalcadaBackdrop({ className }: { className?: string }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1200 640"
      preserveAspectRatio="xMidYMid slice"
      className={cn(
        'calcada-drift pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground',
        className,
      )}
    >
      <CalcadaDefs idPrefix="cx-hero" />

      {/* Limestone cobble field, vignetted. */}
      <g mask="url(#cx-hero-mask)">
        <rect width="1200" height="640" fill="url(#cx-hero-field)" className="opacity-[0.07]" />
      </g>

      {/* Reading-zone fade: the medallion heart sits at the exact center of the
          fold — behind the headline — so the basalt dims to ~40% strength there
          and recovers toward the edges. The strongest ornament must never fight
          the strongest copy; the glyph-in-stone stays as a watermark under the
          text and at full weight where the volutes and outer stones live. The
          orbiting satellites inherit this too: a stone dims while it crosses
          the reading zone and brightens back on the far side of its orbit. */}
      <defs>
        <radialGradient
          id="cx-hero-medfade"
          gradientUnits="userSpaceOnUse"
          cx="600"
          cy="310"
          r="430"
        >
          <stop offset="0%" stopColor="white" stopOpacity="0.4" />
          <stop offset="55%" stopColor="white" stopOpacity="0.68" />
          <stop offset="100%" stopColor="white" stopOpacity="1" />
        </radialGradient>
        <mask id="cx-hero-medfade-mask">
          <rect width="1200" height="640" fill="url(#cx-hero-medfade)" />
        </mask>
      </defs>

      {/* The basalt medallion. The masked wrapper carries the ink weight; the
          chisel filter covers only the LARGE work (ring, blades, big stones) —
          the small orbiting satellites render crisp below, because the jitter
          that reads as hand-cut edge on a 24-unit stroke reads as dust on a
          7-unit stone. */}
      <g mask="url(#cx-hero-medfade-mask)" className="opacity-[0.18]">
      <g filter="url(#cx-hero-stone)">
        {/* The heart: the BRAND GLYPH geometry — socket ring + three dots. */}
        <circle cx="600" cy="300" r="92" fill="none" stroke="currentColor" strokeWidth="26" />
        <circle cx="563" cy="278" r="19" fill="currentColor" />
        <circle cx="637" cy="278" r="19" fill="currentColor" />
        <circle cx="600" cy="347" r="19" fill="currentColor" />

        {/* The long volutes — the "u" blades with curled tips, drawn in.
            The curls stay inside x ∈ [~190, ~1010]: preserveAspectRatio="slice"
            crops up to ~155 viewBox units per side at common laptop aspect
            ratios (≥1280px wide over a ~920px fold), and the curl is the one
            element that must never be amputated by that crop. */}
        <path
          pathLength={1}
          className="calcada-draw"
          d="M 505 205 C 395 128, 265 104, 196 158 C 176 174, 172 198, 190 212 C 206 224, 228 218, 234 201 C 238 186, 226 176, 213 180"
          fill="none"
          stroke="currentColor"
          strokeWidth="24"
          strokeLinecap="round"
        />
        <path
          pathLength={1}
          className="calcada-draw"
          d="M 695 205 C 805 128, 935 104, 1004 158 C 1024 174, 1028 198, 1010 212 C 994 224, 972 218, 966 201 C 962 186, 974 176, 987 180"
          fill="none"
          stroke="currentColor"
          strokeWidth="24"
          strokeLinecap="round"
        />

        {/* The long U beneath — the sweep the third photo nails. */}
        <path
          pathLength={1}
          className="calcada-draw calcada-draw-late"
          d="M 380 430 C 390 540, 560 570, 600 500 C 640 570, 810 540, 820 430"
          fill="none"
          stroke="currentColor"
          strokeWidth="20"
          strokeLinecap="round"
        />

        {/* Trailing dot column, fading like the pavement run-out. */}
        <circle cx="600" cy="560" r="14" fill="currentColor" />
        <circle cx="600" cy="596" r="9" fill="currentColor" />
        <circle cx="600" cy="622" r="5" fill="currentColor" />
      </g>

      {/* Orbiting satellites — the pavement's outer dots, set in motion.
          Unfiltered on purpose: small stones stay crisp (see above). */}
      <g className="calcada-orbit" style={{ transformOrigin: '600px 300px' }}>
        <circle cx="600" cy="130" r="22" fill="currentColor" />
        <circle cx="447" cy="384" r="13" fill="currentColor" />
        <circle cx="753" cy="384" r="13" fill="currentColor" />
        <circle cx="466" cy="200" r="7" fill="currentColor" />
        <circle cx="734" cy="200" r="7" fill="currentColor" />
      </g>
      </g>
    </svg>
  )
}

/**
 * A thin mosaic ribbon between sections — the calçada border band: a running
 * scroll wave with cobble dots, chisel-textured, in the same currentColor ink.
 */
export function CalcadaDivider({ className }: { className?: string }): ReactNode {
  return (
    <div aria-hidden="true" className={cn('mx-auto w-full max-w-5xl px-6', className)}>
      <svg viewBox="0 0 1200 36" preserveAspectRatio="xMidYMid meet" className="h-6 w-full text-foreground">
        <CalcadaDefs idPrefix="cx-div" />
        <g className="opacity-[0.22]">
          {/* The wave keeps its chiseled edge; the 4-unit cobble dots render
              crisp outside the filter — jittered, they read as specks. */}
          <g filter="url(#cx-div-stone)">
            <path
              d="M 0 22 Q 50 2 100 22 T 200 22 T 300 22 T 400 22 T 500 22 T 600 22 T 700 22 T 800 22 T 900 22 T 1000 22 T 1100 22 T 1200 22"
              fill="none"
              stroke="currentColor"
              strokeWidth="7"
              strokeLinecap="round"
            />
          </g>
          {Array.from({ length: 12 }, (_, i) => (
            <circle key={i} cx={100 + i * 100} cy={9} r={4} fill="currentColor" />
          ))}
        </g>
      </svg>
    </div>
  )
}

/**
 * The medallion ornament — the brand glyph rendered as a small calçada
 * roundel (ring + three dots inside a dotted stone circle). Sits above the
 * integration strip: the logo, set in stone.
 */
export function CalcadaMedallion({
  size = 72,
  className,
}: {
  size?: number
  className?: string
}): ReactNode {
  const dots = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2
    return { x: 60 + Math.cos(a) * 52, y: 60 + Math.sin(a) * 52 }
  })
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 120 120"
      className={cn('pointer-events-none text-foreground', className)}
    >
      {/* This canvas is 120 units (vs the hero's 1200), so the chisel scale
          drops to 2.5 — the full-strength jitter shredded the roundel into a
          smudge at its 72px rendered size. */}
      <CalcadaDefs idPrefix="cx-med" stoneScale={2.5} />
      {/* Dotted stone circle — the mosaic frame. Crisp on purpose: 2.6-unit
          stones dissolve under any displacement at this scale. */}
      <g className="calcada-orbit-slow opacity-[0.35]" style={{ transformOrigin: '60px 60px' }}>
        {dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={2.6} fill="currentColor" />
        ))}
      </g>
      {/* The brand glyph geometry, in basalt — lightly chiseled. */}
      <g filter="url(#cx-med-stone)" className="opacity-[0.55]">
        <circle cx="60" cy="60" r="26" fill="none" stroke="currentColor" strokeWidth="8" />
        <circle cx="49.6" cy="53.9" r="5.4" fill="currentColor" />
        <circle cx="70.4" cy="53.9" r="5.4" fill="currentColor" />
        <circle cx="60" cy="73.2" r="5.4" fill="currentColor" />
      </g>
    </svg>
  )
}
