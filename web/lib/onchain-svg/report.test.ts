/**
 * @file report.test.ts — the JSON bridge stays honest: the report prices the
 * SANITIZED bytes (never the raw upload), serializes bigints losslessly, and
 * the regime classifier never force-fits a chain that matches neither pricing
 * rule (the Arbitrum case).
 */
import { describe, expect, it } from 'vitest'
import { GAS, calldataGas, calldataTokens, svgByteStats } from './estimate'
import { buildReport, classifyRegime, LogoError } from './report'

const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#0AF"/></svg>'

describe('buildReport — sanitize first, then price the clean bytes', () => {
  it('prices the sanitized bytes and carries them on the report', () => {
    const r = buildReport(CLEAN_SVG)
    expect(r.kind).toBe('svg')
    expect(r.sanitizedSvg.startsWith('<svg')).toBe(true)
    expect(r.sanitized).toEqual(svgByteStats(r.sanitizedSvg))
    expect(r.strategies).toHaveLength(4)
  })

  it('strips executable content BEFORE pricing — the scrubbed mark is smaller', () => {
    const hostile = CLEAN_SVG.replace('</svg>', '<script>alert(1)</script></svg>')
    const r = buildReport(hostile)
    expect(r.sanitizedSvg).not.toContain('script')
    // The raw upload was bigger than what would actually ship.
    expect(r.rawBytes).toBeGreaterThan(r.sanitized.bytes)
  })

  it('rejects a non-SVG upload with a human LogoError, never a crash', () => {
    expect(() => buildReport('just some text')).toThrow(LogoError)
  })

  it('derives the self-send predictions from the spec formulas exactly', () => {
    const r = buildReport(CLEAN_SVG)
    const stats = r.sanitized
    expect(BigInt(r.predictedLegacy)).toBe(GAS.TX_BASE + calldataGas(stats))
    // A no-execution tx always binds the EIP-7623 floor (10 > 4 per token).
    expect(BigInt(r.predictedFloor)).toBe(GAS.TX_BASE + 10n * calldataTokens(stats))
  })

  it('serializes every gas figure as a lossless decimal string', () => {
    const r = buildReport(CLEAN_SVG)
    for (const s of r.strategies) {
      expect(s.gasLegacy).toMatch(/^\d+$/)
      expect(s.gasFloor).toMatch(/^\d+$/)
      const sum = s.breakdown.reduce((n, l) => n + BigInt(l.gas), 0n)
      expect(sum).toBe(BigInt(s.gasLegacy))
    }
  })
})

describe('classifyRegime — the live node picks its own truth', () => {
  const legacy = 60_000n
  const floor = 120_000n

  it('an exact legacy answer classifies as legacy', () => {
    expect(classifyRegime(60_000n, legacy, floor)).toBe('legacy')
  })

  it('an exact floor answer classifies as eip7623', () => {
    expect(classifyRegime(120_000n, legacy, floor)).toBe('eip7623')
  })

  it('small node padding is absorbed by the tolerance', () => {
    expect(classifyRegime(60_800n, legacy, floor)).toBe('legacy')
    expect(classifyRegime(119_300n, legacy, floor)).toBe('eip7623')
  })

  it('an answer matching NEITHER rule is honestly "other" (the Arbitrum case)', () => {
    // Arbitrum's L1 pricer inflates gasUsed far beyond either prediction.
    expect(classifyRegime(450_000n, legacy, floor)).toBe('other')
    expect(classifyRegime(90_000n, legacy, floor)).toBe('other')
  })

  it('never claims eip7623 when the two predictions coincide (empty payload)', () => {
    expect(classifyRegime(21_000n, 21_000n, 21_000n)).toBe('legacy')
  })

  it('a legacy-priced node is NOT mislabeled eip7623 when predictions are close', () => {
    // Tiny payload: predictedFloor − predictedLegacy = 264 < tolerance, so BOTH
    // are within range. A node answering the legacy number exactly must read
    // 'legacy' (it is the strictly closer match), not 'eip7623'.
    expect(classifyRegime(21_176n, 21_176n, 21_440n)).toBe('legacy')
    // ...and a node answering the floor number reads 'eip7623'.
    expect(classifyRegime(21_440n, 21_176n, 21_440n)).toBe('eip7623')
  })
})
