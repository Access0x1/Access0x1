/**
 * @file bytecodeDiff.ts — the deploy-verification compare core.
 *
 * Given a contract's ON-CHAIN runtime code (what viem `getCode` returns) and the
 * CURRENT build fingerprint vendored in {@link CURRENT_BYTECODE}, decide whether
 * the deployed code MATCHES the current source, DRIFTED (differs — redeploy
 * signal), or has NO-CODE (address with empty bytecode). NOT-DEPLOYED (no
 * address at all) is decided one level up, in the page, since it is the absence
 * of a row rather than a code comparison.
 *
 * The whole point is that this normalizes on-chain code IDENTICALLY to how
 * `scripts/gen-deployments.mjs` normalized the artifact, so the two hashes are
 * comparable: strip a canonical solc CBOR metadata tail IF present, and zero the
 * immutable byte ranges (the constructor bakes immutables into on-chain code,
 * but the artifact leaves them as zeros — without this, every contract with an
 * immutable would falsely read DRIFTED). This module has NO React/RPC deps so it
 * is trivially unit-testable.
 */
import { keccak256, type Hex } from 'viem'
import { CURRENT_BYTECODE, type ContractBytecode } from './currentBytecode'

/** The verification verdict for one deployed contract. */
export type DiffStatus = 'MATCHES' | 'DRIFTED' | 'NOT-DEPLOYED' | 'NO-CODE' | 'UNKNOWN'

/**
 * Strip a trailing solc CBOR metadata tail from a runtime-code hex string (NO
 * `0x` prefix, lower-case) IF one is present, else return it unchanged.
 *
 * The canonical tail is `… a2 64 <key> … 64 'solc' 43 <ver> 00 33`; its last two
 * bytes encode the CBOR length L, and the region removed is the final (L + 2)
 * bytes. We only strip when that region actually starts with the `a264` CBOR map
 * header — so ordinary code whose final two bytes happen to parse as a length is
 * never truncated. This repo currently builds with `cbor_metadata = false`, so
 * the common case is "no tail, returned unchanged"; the strip exists so a
 * metadata-bearing on-chain code (or a future metadata-on build) still compares.
 */
export function stripMetadata(hexNo0x: string): string {
  if (hexNo0x.length < 4) return hexNo0x
  const cborLen = parseInt(hexNo0x.slice(-4), 16)
  if (!Number.isInteger(cborLen) || cborLen <= 0) return hexNo0x
  const tailChars = (cborLen + 2) * 2
  if (tailChars > hexNo0x.length) return hexNo0x
  const marker = hexNo0x.slice(hexNo0x.length - tailChars, hexNo0x.length - tailChars + 4)
  if (marker !== 'a264') return hexNo0x
  return hexNo0x.slice(0, hexNo0x.length - tailChars)
}

/**
 * Zero the immutable byte ranges in a runtime-code hex string (NO `0x` prefix).
 * `ranges` is `[startByte, lengthBytes]` pairs from the build artifact. Zeroing
 * both the on-chain code and the (already-zero) artifact code neutralizes
 * constructor-baked immutables so a source-identical contract compares equal.
 */
export function zeroImmutables(
  hexNo0x: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): string {
  if (ranges.length === 0) return hexNo0x
  const chars = hexNo0x.split('')
  for (const [start, len] of ranges) {
    const from = start * 2
    const to = from + len * 2
    for (let i = from; i < to && i < chars.length; i++) chars[i] = '0'
  }
  return chars.join('')
}

/**
 * Normalize raw on-chain runtime code into the canonical, comparable form: strip
 * the metadata tail, zero the immutables, lower-case. Accepts the value viem
 * `getCode` returns (a `0x`-prefixed hex string, possibly with mixed case).
 */
export function normalizeRuntimeCode(
  code: string,
  immutableRanges: ReadonlyArray<readonly [number, number]>,
): string {
  // Lower-case first so a `0x`/`0X` prefix and any upper-case hex digits are
  // handled uniformly (viem returns lower-case `0x`, but be robust to both).
  const lower = code.toLowerCase()
  const noPrefix = lower.startsWith('0x') ? lower.slice(2) : lower
  return zeroImmutables(stripMetadata(noPrefix), immutableRanges)
}

/**
 * keccak256 of the normalized on-chain runtime code — the same hash the
 * generator stored for the artifact, so the two are directly comparable.
 */
export function hashOnchainCode(
  code: string,
  immutableRanges: ReadonlyArray<readonly [number, number]>,
): Hex {
  return keccak256(`0x${normalizeRuntimeCode(code, immutableRanges)}`)
}

/** Is this `getCode` result an empty / no-code response? */
function isEmptyCode(code: string | undefined | null): boolean {
  if (!code) return true
  const noPrefix = code.startsWith('0x') ? code.slice(2) : code
  return noPrefix.length === 0
}

/**
 * Compare a contract's ON-CHAIN code against the current build.
 *
 * @param contractName Which contract (keys {@link CURRENT_BYTECODE}).
 * @param onchainCode  The `getCode(address)` result, or `undefined`/`'0x'` when
 *                     the address has no code.
 * @returns
 *   - `NO-CODE`  — the address has no bytecode (self-destructed / wrong address).
 *   - `UNKNOWN`  — no current-build fingerprint exists for this contract name
 *                  (the artifact was not built), so we cannot judge it.
 *   - `MATCHES`  — normalized on-chain hash == current-build hash.
 *   - `DRIFTED`  — they differ: the deployed code is stale, REDEPLOY.
 *
 * `NOT-DEPLOYED` is never returned here — the page emits it when no address
 * exists, which is an absence rather than a code read.
 */
export function diffContract(
  contractName: string,
  onchainCode: string | undefined | null,
): DiffStatus {
  const current: ContractBytecode | undefined = CURRENT_BYTECODE[contractName]
  if (!current) return 'UNKNOWN'
  if (isEmptyCode(onchainCode)) return 'NO-CODE'
  const onchainHash = hashOnchainCode(onchainCode as string, current.immutableRanges)
  return onchainHash === current.codeHash ? 'MATCHES' : 'DRIFTED'
}
