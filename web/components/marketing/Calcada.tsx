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
 *    deterministic running-bond BRICK field (real paving courses with mortar
 *    joints) — same output on server and client, so there is no hydration drift.
 *  - Animation is CSS-only (orbit, draw-in via pathLength=1, slow drift) and
 *    every class no-ops under prefers-reduced-motion (see globals.css).
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The hero blade geometry, defined ONCE: each path is drawn twice — the basalt
 * stroke, then a background-colored dashed seam overlay that cuts the blade
 * into individual set stones (in the real pavement every scroll is tessellated
 * from small basalt cubes; a smooth vector ribbon reads as paint, not stone).
 * Single source keeps the stroke and its seams from ever drifting apart.
 */
const VOLUTE_LEFT =
  'M 505 205 C 395 128, 265 104, 196 158 C 176 174, 172 198, 190 212 C 206 224, 228 218, 234 201 C 238 186, 226 176, 213 180'
const VOLUTE_RIGHT =
  'M 695 205 C 805 128, 935 104, 1004 158 C 1024 174, 1028 198, 1010 212 C 994 224, 972 218, 966 201 C 962 186, 974 176, 987 180'
const UNDER_SWEEP =
  'M 380 430 C 390 540, 560 570, 600 500 C 640 570, 810 540, 820 430'

/** Seam paint: the page background, so a "joint" is a true gap in the stone. */
const SEAM_STROKE = { stroke: 'hsl(var(--background))' } as const

/** The phone composition's blade geometry (recurled to stay inside a 375px band). */
const M_VOLUTE_LEFT =
  'M 232 200 C 186 168 148 166 132 190 C 122 204 128 220 143 222 C 155 223 162 212 156 202'
const M_VOLUTE_RIGHT =
  'M 368 200 C 414 168 452 166 468 190 C 478 204 472 220 457 222 C 445 223 438 212 444 202'
const M_UNDER_SWEEP = 'M 210 420 C 220 500 275 525 300 480 C 325 525 380 500 390 420'

/**
 * mulberry32 — a tiny SEEDED PRNG. Seeded is the whole point: the floor is
 * "randomly generated" the way a real calceteiro's floor is (no two bricks
 * alike), but the fixed seed makes every render — server and client — emit
 * the identical layout, so the no-hydration-drift law holds. Math.random()
 * here would tear the page apart on hydration.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Brick {
  x: number
  y: number
  w: number
  h: number
  /** fired-clay tone — no two neighbors match */
  o: number
  /** the hand-laid lie, in degrees */
  r: number
  /** a glazed azulejo stone, set in the brand primary */
  glazed: boolean
}

/**
 * The floor, laid ONCE at module load on a 600×240 generated tile — large
 * enough that the repeat is invisible behind copy, cheap enough that the DOM
 * carries the tile once (SVG patterns paint by reference, not by copy).
 * Every course draws its own stagger, every brick its own width, tone and
 * half-degree lie; a brick crossing the right seam is laid again at the wrap
 * so the bond tiles seamlessly. ~5% of stones come up glazed.
 */
const TILE_W = 600
const TILE_H = 240
const BRICKS: readonly Brick[] = (() => {
  const rng = mulberry32(0xca1cada)
  const out: Brick[] = []
  const courses = 18
  const pitch = TILE_H / courses
  const r1 = (n: number): number => Math.round(n * 10) / 10
  for (let c = 0; c < courses; c++) {
    const y = r1(c * pitch + 1 + (rng() - 0.5) * 0.8)
    const h = r1(pitch - 2.2 - rng() * 0.6)
    let x = -rng() * 30
    while (x < TILE_W) {
      const w = r1(20 + rng() * 14)
      const b: Brick = {
        x: r1(x),
        y,
        w,
        h,
        o: Math.round((0.5 + rng() * 0.5) * 100) / 100,
        r: r1((rng() - 0.5) * 1.6),
        glazed: rng() < 0.05,
      }
      out.push(b)
      if (x + w > TILE_W) out.push({ ...b, x: r1(x - TILE_W) })
      x += w + 1.8 + rng() * 1.2
    }
  }
  return out
})()

/** Render the laid floor (pattern-tile content). */
function BrickField(): ReactNode {
  return (
    <>
      {BRICKS.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx="1.2"
          {...(b.glazed
            ? { style: { fill: 'hsl(var(--primary))' } }
            : { fill: 'currentColor' })}
          fillOpacity={b.o}
          transform={`rotate(${b.r} ${r2(b.x + b.w / 2)} ${r2(b.y + b.h / 2)})`}
        />
      ))}
    </>
  )
}
/** one-decimal rounding for transform origins (keeps SSR payload lean) */
function r2(n: number): number {
  return Math.round(n * 10) / 10
}

/** Shared defs: the stone-edge filter + the generated brick field + fade mask. */
function CalcadaDefs({
  idPrefix,
  stoneScale = 7,
  withField = true,
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
  /**
   * Whether to emit the generated brick-field pattern. The heroes use it; the
   * divider and medallion never paint the field, and the tile is ~380 rects
   * of SSR payload — don't ship it where nothing references it.
   */
  withField?: boolean
}): ReactNode {
  return (
    <defs>
      {/* Hand-cut basalt: jitter the vector edges like chiseled stone. */}
      <filter id={`${idPrefix}-stone`} x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale={stoneScale} />
      </filter>

      {/* The brick floor — SEEDED-GENERATED, not hand-tiled (see BRICKS above):
          a 600×240 tile whose every course draws its own stagger and every
          brick its own width, tone and lie, with ~5% glazed stones in the
          brand primary. Mortar joints are true gaps (page background through).
          Deterministic by seed — identical on server and client. */}
      {withField && (
        <pattern
          id={`${idPrefix}-field`}
          width={TILE_W}
          height={TILE_H}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(8)"
        >
          <BrickField />
        </pattern>
      )}

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
 * The full-bleed hero backdrop: the brick floor + the IMG_0025 medallion —
 * the brand ring with its three dots, orbiting satellites, long curled volutes
 * left and right, and the trailing dot column beneath. Decorative only.
 *
 * Responsive by composition, not by cropping: `slice` on the 1200-unit canvas
 * crops ~412 units per SIDE at a 375px phone width — the volute curls (the one
 * element the desktop notes say must never be amputated) were the first thing
 * cut. So the desktop svg renders from `sm:` up, and phones get a dedicated
 * 600-unit composition whose volutes curl INSIDE the visible band. Same
 * elements, same classes, no client JS — just two server-rendered svgs.
 */
export function CalcadaBackdrop({ className }: { className?: string }): ReactNode {
  return (
    <>
    <svg
      aria-hidden="true"
      viewBox="0 0 1200 640"
      preserveAspectRatio="xMidYMid slice"
      className={cn(
        'calcada-drift pointer-events-none absolute inset-0 -z-10 hidden h-full w-full text-foreground sm:block',
        className,
      )}
    >
      <CalcadaDefs idPrefix="cx-hero" />

      {/* THE POMBALINE CUT. In the real Baixa pavement the black basalt figure
          is not laid OVER the white field — the field stones are cut and set
          AROUND it, flush. Same here: this mask knocks the medallion's
          footprint (each element a few units wider than its stroke — the
          setting bed) out of the brick field, so the basalt drawn later sits
          IN the floor, not on top of it. The orbiting satellites stay outside
          the cut on purpose: they move, and a cut cannot follow a stone. */}
      <defs>
        <mask id="cx-hero-cut">
          <rect width="1200" height="640" fill="white" />
          <g stroke="black" fill="black">
            <circle cx="600" cy="300" r="92" fill="none" strokeWidth="35" />
            <circle cx="563" cy="278" r="24" />
            <circle cx="637" cy="278" r="24" />
            <circle cx="600" cy="347" r="24" />
            <path d={VOLUTE_LEFT} fill="none" strokeWidth="33" strokeLinecap="round" />
            <path d={VOLUTE_RIGHT} fill="none" strokeWidth="33" strokeLinecap="round" />
            <path d={UNDER_SWEEP} fill="none" strokeWidth="29" strokeLinecap="round" />
            <circle cx="600" cy="560" r="19" />
            <circle cx="600" cy="596" r="14" />
            <circle cx="600" cy="622" r="10" />
          </g>
        </mask>
      </defs>

      {/* Brick floor, vignetted, with the medallion footprint cut out. */}
      <g mask="url(#cx-hero-mask)">
        <g mask="url(#cx-hero-cut)">
          <rect width="1200" height="640" fill="url(#cx-hero-field)" className="opacity-[0.1]" />
        </g>
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
        {/* The heart: the BRAND GLYPH geometry — socket ring + three dots.
            The ring carries radial seam joints (the dashed overlay below) so it
            reads as a course of set stones; the dots are single stones. */}
        <circle cx="600" cy="300" r="92" fill="none" stroke="currentColor" strokeWidth="26" />
        <circle
          cx="600"
          cy="300"
          r="92"
          fill="none"
          strokeWidth="26"
          strokeDasharray="3.5 17.5"
          style={SEAM_STROKE}
        />
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
          d={VOLUTE_LEFT}
          fill="none"
          stroke="currentColor"
          strokeWidth="24"
          strokeLinecap="round"
        />
        <path
          pathLength={1}
          className="calcada-draw"
          d={VOLUTE_RIGHT}
          fill="none"
          stroke="currentColor"
          strokeWidth="24"
          strokeLinecap="round"
        />
        {/* Seam overlays: background-colored joints cut each blade into set
            stones. Static (no draw-in) — seams over an undrawn blade are
            background-on-background, so they only appear as the blade does. */}
        <path d={VOLUTE_LEFT} fill="none" strokeWidth="24" strokeDasharray="3.5 17.5" style={SEAM_STROKE} />
        <path d={VOLUTE_RIGHT} fill="none" strokeWidth="24" strokeDasharray="3.5 17.5" style={SEAM_STROKE} />

        {/* The long U beneath — the sweep the third photo nails. */}
        <path
          pathLength={1}
          className="calcada-draw calcada-draw-late"
          d={UNDER_SWEEP}
          fill="none"
          stroke="currentColor"
          strokeWidth="20"
          strokeLinecap="round"
        />
        <path d={UNDER_SWEEP} fill="none" strokeWidth="20" strokeDasharray="3 15" style={SEAM_STROKE} />

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

    {/* The phone composition: 600-unit canvas, medallion centered, volutes
        recurled tight so every curl lives inside the ~350-unit band a 375px
        screen actually shows under `slice`. Chisel scale drops with the canvas
        (see CalcadaDefs). Classes and structure mirror the desktop svg. */}
    <svg
      aria-hidden="true"
      viewBox="0 0 600 640"
      preserveAspectRatio="xMidYMid slice"
      className={cn(
        'calcada-drift pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground sm:hidden',
        className,
      )}
    >
      <CalcadaDefs idPrefix="cx-herom" stoneScale={4} />

      {/* The Pombaline cut, phone geometry (see the desktop note). */}
      <defs>
        <mask id="cx-herom-cut">
          <rect width="600" height="640" fill="white" />
          <g stroke="black" fill="black">
            <circle cx="300" cy="290" r="78" fill="none" strokeWidth="30" />
            <circle cx="269" cy="271" r="20" />
            <circle cx="331" cy="271" r="20" />
            <circle cx="300" cy="330" r="20" />
            <path d={M_VOLUTE_LEFT} fill="none" strokeWidth="28" strokeLinecap="round" />
            <path d={M_VOLUTE_RIGHT} fill="none" strokeWidth="28" strokeLinecap="round" />
            <path d={M_UNDER_SWEEP} fill="none" strokeWidth="25" strokeLinecap="round" />
            <circle cx="300" cy="545" r="16" />
            <circle cx="300" cy="577" r="12" />
            <circle cx="300" cy="600" r="8" />
          </g>
        </mask>
      </defs>

      {/* Brick floor, vignetted, medallion footprint cut out — phone canvas. */}
      <g mask="url(#cx-herom-mask)">
        <g mask="url(#cx-herom-cut)">
          <rect width="600" height="640" fill="url(#cx-herom-field)" className="opacity-[0.1]" />
        </g>
      </g>

      {/* Reading-zone fade, recentred for the phone fold. */}
      <defs>
        <radialGradient
          id="cx-herom-medfade"
          gradientUnits="userSpaceOnUse"
          cx="300"
          cy="300"
          r="260"
        >
          <stop offset="0%" stopColor="white" stopOpacity="0.4" />
          <stop offset="55%" stopColor="white" stopOpacity="0.68" />
          <stop offset="100%" stopColor="white" stopOpacity="1" />
        </radialGradient>
        <mask id="cx-herom-medfade-mask">
          <rect width="600" height="640" fill="url(#cx-herom-medfade)" />
        </mask>
      </defs>

      <g mask="url(#cx-herom-medfade-mask)" className="opacity-[0.18]">
      <g filter="url(#cx-herom-stone)">
        {/* The heart: brand glyph geometry at phone scale. */}
        <circle cx="300" cy="290" r="78" fill="none" stroke="currentColor" strokeWidth="22" />
        <circle
          cx="300"
          cy="290"
          r="78"
          fill="none"
          strokeWidth="22"
          strokeDasharray="3 15"
          style={SEAM_STROKE}
        />
        <circle cx="269" cy="271" r="16" fill="currentColor" />
        <circle cx="331" cy="271" r="16" fill="currentColor" />
        <circle cx="300" cy="330" r="16" fill="currentColor" />

        {/* Short volutes — same gesture, curls held inside x ∈ [130, 470]. */}
        <path
          pathLength={1}
          className="calcada-draw"
          d={M_VOLUTE_LEFT}
          fill="none"
          stroke="currentColor"
          strokeWidth="20"
          strokeLinecap="round"
        />
        <path
          pathLength={1}
          className="calcada-draw"
          d={M_VOLUTE_RIGHT}
          fill="none"
          stroke="currentColor"
          strokeWidth="20"
          strokeLinecap="round"
        />
        <path d={M_VOLUTE_LEFT} fill="none" strokeWidth="20" strokeDasharray="3 15" style={SEAM_STROKE} />
        <path d={M_VOLUTE_RIGHT} fill="none" strokeWidth="20" strokeDasharray="3 15" style={SEAM_STROKE} />

        {/* The under-sweep, narrowed to the phone band. */}
        <path
          pathLength={1}
          className="calcada-draw calcada-draw-late"
          d={M_UNDER_SWEEP}
          fill="none"
          stroke="currentColor"
          strokeWidth="17"
          strokeLinecap="round"
        />
        <path d={M_UNDER_SWEEP} fill="none" strokeWidth="17" strokeDasharray="2.6 13" style={SEAM_STROKE} />

        {/* Trailing dot column. */}
        <circle cx="300" cy="545" r="12" fill="currentColor" />
        <circle cx="300" cy="577" r="8" fill="currentColor" />
        <circle cx="300" cy="600" r="4.5" fill="currentColor" />
      </g>

      {/* Orbiting satellites — radii sized so the full orbit stays on-screen. */}
      <g className="calcada-orbit" style={{ transformOrigin: '300px 290px' }}>
        <circle cx="300" cy="150" r="16" fill="currentColor" />
        <circle cx="185" cy="350" r="10" fill="currentColor" />
        <circle cx="415" cy="350" r="10" fill="currentColor" />
        <circle cx="200" cy="205" r="5.5" fill="currentColor" />
        <circle cx="400" cy="205" r="5.5" fill="currentColor" />
      </g>
      </g>
    </svg>
    </>
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
        <CalcadaDefs idPrefix="cx-div" withField={false} />
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
      <CalcadaDefs idPrefix="cx-med" stoneScale={2.5} withField={false} />
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
