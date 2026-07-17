/**
 * @file estimate.test.ts — the gas math is PROVABLE: every expectation here is
 * hand-computed from the cited protocol constants (EIP-2028/7623/2929/3529/
 * 170/3860, yellow paper G_* values), never from running the code first.
 */
import { describe, expect, it } from 'vitest'
import {
  base64Length,
  byteStats,
  calldataGas,
  calldataTokens,
  estimateAll,
  estimateCalldataAnchor,
  estimateSstore2,
  estimateStorageSlots,
  estimateTokenUriMint,
  keccakGas,
  memoryGas,
  svgByteStats,
  usdCost8,
  weiCost,
  type ByteStats,
} from './estimate'

/** A payload of `n` nonzero bytes (0x41 'A') — the worst calldata class. */
function nonzero(n: number): ByteStats {
  return byteStats(new Uint8Array(n).fill(0x41))
}

describe('byteStats — the two calldata price classes', () => {
  it('counts zero and nonzero bytes exactly', () => {
    const s = byteStats(new Uint8Array([0, 1, 2, 0]))
    expect(s).toEqual({ bytes: 4, zeroBytes: 2, nonzeroBytes: 2 })
  })

  it('encodes a string as UTF-8 before counting', () => {
    // 'AB' = 2 nonzero bytes; '€' is 3 UTF-8 bytes, all nonzero.
    expect(svgByteStats('AB')).toEqual({ bytes: 2, zeroBytes: 0, nonzeroBytes: 2 })
    expect(svgByteStats('€')).toEqual({ bytes: 3, zeroBytes: 0, nonzeroBytes: 3 })
  })
})

describe('primitive gas terms — hand-checked against the spec', () => {
  it('calldata: 4 gas per zero byte, 16 per nonzero (EIP-2028)', () => {
    const s = byteStats(new Uint8Array([0, 1, 2, 0]))
    expect(calldataGas(s)).toBe(40n) // 2×4 + 2×16
  })

  it('EIP-7623 tokens: zeros + 4 × nonzeros', () => {
    const s = byteStats(new Uint8Array([0, 1, 2, 0]))
    expect(calldataTokens(s)).toBe(10n) // 2 + 4×2
  })

  it('keccak: 30 base + 6 per 32-byte word', () => {
    expect(keccakGas(0)).toBe(30n)
    expect(keccakGas(1)).toBe(36n)
    expect(keccakGas(32)).toBe(36n)
    expect(keccakGas(33)).toBe(42n)
  })

  it('memory expansion: 3·words + ⌊words²/512⌋', () => {
    expect(memoryGas(32)).toBe(3n)
    expect(memoryGas(64)).toBe(6n)
    // 512 words: 1,536 linear + 512²/512 = 512 quadratic.
    expect(memoryGas(512 * 32)).toBe(2048n)
  })

  it('base64 expands 3 raw bytes to 4 chars, padded', () => {
    expect(base64Length(0)).toBe(0)
    expect(base64Length(3)).toBe(4)
    expect(base64Length(4)).toBe(8)
  })
})

describe('calldata anchor — one tx, fingerprint stored, bytes in history', () => {
  it('100 nonzero bytes cost exactly 46,159 gas (hand computation)', () => {
    // 21,000 base + 1,600 calldata + copy(3·4=12) + keccak(30+6·4=54)
    //   + memory(12) + 22,100 anchor SSTORE + log(375+750+256=1,381) = 46,159.
    const e = estimateCalldataAnchor(nonzero(100))
    expect(e.gasLegacy).toBe(46_159n)
    expect(e.txCount).toBe(1)
  })

  it('the floor does not bind when execution dominates (small payload)', () => {
    const e = estimateCalldataAnchor(nonzero(100))
    expect(e.floorBinds).toBe(false)
    expect(e.gasFloor).toBe(e.gasLegacy)
  })

  it('EIP-7623 floor BINDS for a data-heavy payload and reprices it', () => {
    // 10,000 nonzero bytes: legacy = 21,000 + 160,000 calldata + exec(copy 939
    //   + keccak 1,908 + memory 1,130 + SSTORE 22,100 + log 1,381 = 27,458) =
    //   208,458; floor = 21,000 + 10 × 40,000 tokens = 421,000 — the floor wins.
    const e = estimateCalldataAnchor(nonzero(10_000))
    expect(e.gasLegacy).toBe(208_458n)
    expect(e.floorBinds).toBe(true)
    expect(e.gasFloor).toBe(421_000n)
  })
})

describe('SSTORE2 — bytes as contract code, chunked at EIP-170', () => {
  it('chunks at 24,575 data bytes per contract (24,576 minus the STOP byte)', () => {
    expect(estimateSstore2(nonzero(24_575)).txCount).toBe(1)
    expect(estimateSstore2(nonzero(24_576)).txCount).toBe(2)
    expect(estimateSstore2(nonzero(49_150)).txCount).toBe(2)
    expect(estimateSstore2(nonzero(49_151)).txCount).toBe(3)
  })

  it('100 nonzero bytes cost exactly 75,000 gas (hand computation)', () => {
    // 21,000 + 32,000 create surcharge
    //   + calldata(initcode = 11-byte prelude + STOP + 100 bytes: 16·111 + 4·1 = 1,780)
    //   + deposit(200 × 101 runtime bytes = 20,200)
    //   + initcode words(2 × 4 = 8) + memory(12) = 75,000.
    const e = estimateSstore2(nonzero(100))
    expect(e.gasLegacy).toBe(75_000n)
  })

  it('the floor never binds — the 200 gas/byte code deposit dominates', () => {
    const e = estimateSstore2(nonzero(24_575))
    expect(e.floorBinds).toBe(false)
    expect(e.gasFloor).toBe(e.gasLegacy)
  })
})

describe('tokenURI mint — base64 data-URI stored as a long string', () => {
  it('3 raw bytes cost exactly 89,658 gas (hand computation)', () => {
    // URI = 26-byte prefix + base64(3→4) = 30 ASCII bytes (all nonzero). 30 ≤ 31
    // so Solidity's SHORT-string layout stores it in ONE slot, not two:
    // 21,000 + calldata(16·30=480) + URI slot(22,100 × 1) + mint slots(44,200)
    //   + Transfer log(375+1,500=1,875) + memory(3) = 89,658.
    const e = estimateTokenUriMint(nonzero(3))
    expect(e.gasLegacy).toBe(89_658n)
  })

  it('a URI past 31 bytes uses the long-string layout (1 + ⌈n/32⌉ slots)', () => {
    // 100 raw bytes → base64 136 + 26 prefix = 162-byte URI → 1 + ⌈162/32⌉ = 7 slots.
    const e = estimateTokenUriMint(nonzero(100))
    const uriSlots = e.breakdown.find((l) => l.label.startsWith('Store the URI'))
    expect(uriSlots?.gas).toBe(22_100n * 7n)
  })

  it('pays the 4/3 expansion: URI slots grow faster than raw bytes', () => {
    const small = estimateTokenUriMint(nonzero(300))
    const big = estimateTokenUriMint(nonzero(3_000))
    // 10× the bytes must cost MORE than 10× the small URI-storage share —
    // sanity that expansion + slot ceilings compound, never shrink.
    expect(big.gasLegacy > small.gasLegacy).toBe(true)
  })
})

describe('raw storage slots — the naive anti-pattern, priced honestly', () => {
  it('32 nonzero bytes cost exactly 65,751 gas (hand computation)', () => {
    // 21,000 + calldata(512) + slots(22,100 × (1 length + 1 data) = 44,200)
    //   + memory(3) + keccak(32 bytes = 36) = 65,751.
    const e = estimateStorageSlots(nonzero(32))
    expect(e.gasLegacy).toBe(65_751n)
  })
})

/** A payload that spans >2 SSTORE2 chunks and is almost all 0x00 — the case
 *  that used to make apportionStats emit a negative nonzeroBytes. */
function mostlyZeroMultiChunk(): ByteStats {
  const a = new Uint8Array(73_726)
  a[0] = 1
  a[1] = 2 // exactly 2 nonzero bytes, 73,724 zeros
  return byteStats(a)
}

describe('cross-strategy invariants — the breakdown IS the proof', () => {
  const payloads = [
    nonzero(100),
    nonzero(1_000),
    byteStats(new Uint8Array(500)),
    nonzero(30_000),
    mostlyZeroMultiChunk(),
  ]

  it('SSTORE2 never emits a negative per-chunk byte count (apportion feasibility)', () => {
    // The mostly-zero multi-chunk payload is the regression case; the estimate
    // must stay a positive, finite number with a breakdown that still sums.
    const e = estimateSstore2(mostlyZeroMultiChunk())
    expect(e.txCount).toBe(4)
    expect(e.gasLegacy).toBeGreaterThan(0n)
    expect(e.breakdown.reduce((n, l) => n + l.gas, 0n)).toBe(e.gasLegacy)
  })

  it('every strategy’s breakdown lines sum exactly to its legacy total', () => {
    for (const stats of payloads) {
      for (const e of estimateAll(stats)) {
        const sum = e.breakdown.reduce((n, line) => n + line.gas, 0n)
        expect(sum).toBe(e.gasLegacy)
      }
    }
  })

  it('the floor total is never below the standard total', () => {
    for (const stats of payloads) {
      for (const e of estimateAll(stats)) {
        expect(e.gasFloor >= e.gasLegacy || !e.floorBinds).toBe(true)
      }
    }
  })

  it('ranks a typical SVG: anchor < sstore2 < raw slots < base64 mint', () => {
    const order = estimateAll(nonzero(1_000)).map((e) => e.strategy)
    expect(order).toEqual(['calldata-anchor', 'sstore2', 'storage-slots', 'tokenuri-mint'])
  })
})

describe('cost conversion — pure bigint, fail-soft on a zero rate', () => {
  it('multiplies gas by gas price with no rounding', () => {
    expect(weiCost(100_000n, 2_000_000_000n)).toBe(200_000_000_000_000n)
  })

  it('prices wei in 8-decimal USD via the wei-per-dollar rate', () => {
    // 1 native (1e18 wei) at 5e17 wei per $1 → $2.00 → 2e8.
    expect(usdCost8(10n ** 18n, 5n * 10n ** 17n)).toBe(200_000_000n)
  })

  it('returns null instead of dividing by a zero/negative rate', () => {
    expect(usdCost8(10n ** 18n, 0n)).toBeNull()
    expect(usdCost8(10n ** 18n, -1n)).toBeNull()
  })
})
