/**
 * report.ts — the JSON-safe bridge between the pure gas math ({@link estimate})
 * and the API route / UI. Sanitizes the uploaded mark with the SAME scrubber
 * the branding pipeline trusts (logo.ts — never a second, weaker sanitizer),
 * runs all four strategies on the CLEAN bytes (what we would actually store),
 * and serializes bigints to strings.
 *
 * Pure + synchronous: everything here unit-tests offline. The route adds the
 * live node data (eth_estimateGas / gas price / the router's $1 quote) around
 * this report, each part fail-soft — a dead RPC can never take down the math.
 */
import { toInlineSvgLogo, LogoError } from '@/lib/branding/logo'
import {
  calldataGas,
  calldataTokens,
  estimateAll,
  svgByteStats,
  GAS,
  type ByteStats,
  type StrategyEstimate,
} from './estimate'

/** A JSON-safe breakdown line (gas as decimal string). */
export interface BreakdownLineJson {
  label: string
  formula: string
  gas: string
}

/** A JSON-safe strategy estimate. */
export interface StrategyEstimateJson {
  strategy: StrategyEstimate['strategy']
  title: string
  description: string
  txCount: number
  gasLegacy: string
  gasFloor: string
  floorBinds: boolean
  breakdown: BreakdownLineJson[]
  notes: string[]
}

/** The pure part of the simulator's answer — no network involved. */
export interface OnchainSvgReport {
  /** How the input was normalized ('svg' sanitized in place, 'raster' wrapped). */
  kind: 'svg' | 'raster'
  /**
   * The sanitized inline SVG itself — the EXACT bytes every strategy priced,
   * the live probe publishes, and the UI previews. One string, one truth.
   */
  sanitizedSvg: string
  /** Byte size of the input as uploaded. */
  rawBytes: number
  /** Byte shape of the SANITIZED mark — the bytes that would actually ship. */
  sanitized: ByteStats
  /** All four strategies, cheapest first, JSON-safe. */
  strategies: StrategyEstimateJson[]
  /**
   * The self-send prediction pair for the live cross-check: the same calldata
   * publish priced under each regime. `predictedLegacy` = 21000 + 16/4·bytes;
   * `predictedFloor` = 21000 + max(4, 10)·tokens (EIP-7623).
   */
  predictedLegacy: string
  predictedFloor: string
}

/** Serialize one strategy (bigint → string) for the wire. */
export function serializeEstimate(e: StrategyEstimate): StrategyEstimateJson {
  return {
    strategy: e.strategy,
    title: e.title,
    description: e.description,
    txCount: e.txCount,
    gasLegacy: e.gasLegacy.toString(),
    gasFloor: e.gasFloor.toString(),
    floorBinds: e.floorBinds,
    breakdown: e.breakdown.map((l) => ({ label: l.label, formula: l.formula, gas: l.gas.toString() })),
    notes: e.notes,
  }
}

/**
 * Build the full pure report for an uploaded mark (SVG markup or a raster
 * data-URI). Throws {@link LogoError} with a human message on anything the
 * sanitizer rejects — the route maps that to an honest 400.
 */
export function buildReport(input: string): OnchainSvgReport {
  const { svg, kind } = toInlineSvgLogo(input)
  const rawBytes = new TextEncoder().encode(input).length
  const sanitized = svgByteStats(svg)
  const tokens = calldataTokens(sanitized)
  const standard = GAS.STANDARD_PER_TOKEN * tokens
  const floor = GAS.FLOOR_PER_TOKEN * tokens
  return {
    kind,
    sanitizedSvg: svg,
    rawBytes,
    sanitized,
    strategies: estimateAll(sanitized).map(serializeEstimate),
    predictedLegacy: (GAS.TX_BASE + calldataGas(sanitized)).toString(),
    predictedFloor: (GAS.TX_BASE + (floor > standard ? floor : standard)).toString(),
  }
}

/** Which calldata-pricing regime a live node's answer matches. */
export type GasRegime = 'legacy' | 'eip7623' | 'other'

/**
 * Classify a live `eth_estimateGas` answer against the two predictions. Exact
 * matches are expected on vanilla EVM chains; a small tolerance absorbs node
 * padding. Anything far from both (e.g. Arbitrum's L1-pricer inflation, an
 * OP-Stack fee component) is honestly 'other' — never force-fitted.
 */
export function classifyRegime(
  live: bigint,
  predictedLegacy: bigint,
  predictedFloor: bigint,
  tolerance = 1_000n,
): GasRegime {
  const dLegacy = live > predictedLegacy ? live - predictedLegacy : predictedLegacy - live
  const dFloor = live > predictedFloor ? live - predictedFloor : predictedFloor - live
  if (dFloor <= tolerance && predictedFloor !== predictedLegacy) return 'eip7623'
  if (dLegacy <= tolerance) return 'legacy'
  return 'other'
}

export { LogoError }
