/**
 * ulid.ts — dependency-free ULID generator for payment-intent ids.
 *
 * WHY ULID (and why no dependency): intent ids must be (a) globally unique
 * without coordination, (b) lexicographically time-ordered so intent listings
 * and DB scans sort chronologically for free, and (c) 26 chars of Crockford
 * base32 — which fits the on-chain `orderId` bridge: 26 ascii bytes pad into
 * one bytes32 with room to spare (see types.ts). The spec is small enough
 * that a ~40-line local implementation beats a supply-chain edge for a
 * money-adjacent id (the fewer packages between "create sale" and "match
 * on-chain event", the better).
 *
 * Monotonicity: within one millisecond the 80-bit random tail is INCREMENTED
 * rather than re-rolled, so two intents created in the same ms still sort in
 * creation order (and can never collide in-process). Across processes,
 * 80 random bits per ms make collision astronomically unlikely.
 */

/** Crockford base32 — no I, L, O, U (the ULID alphabet). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const ULID_LENGTH = 26

/** Matches exactly one canonical ULID (uppercase Crockford base32). */
export const ULID_REGEX = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

let lastTime = -1
// 10 bytes = the 80-bit randomness tail, kept for same-ms incrementing.
let lastRandom = new Uint8Array(10)

function encodeTime(timeMs: number): string {
  let out = ''
  let t = timeMs
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out
    t = Math.floor(t / 32)
  }
  return out
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes = 80 bits = 16 base32 chars exactly.
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

/** Increment the 80-bit tail by one (big-endian), wrapping only at 2^80. */
function increment(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0xff) {
      bytes[i] = 0
    } else {
      bytes[i] += 1
      return
    }
  }
}

/**
 * Generate one ULID. `nowMs` is injectable for deterministic tests; production
 * callers pass nothing.
 */
export function ulid(nowMs: number = Date.now()): string {
  if (nowMs === lastTime) {
    increment(lastRandom)
  } else {
    lastTime = nowMs
    lastRandom = new Uint8Array(10)
    globalThis.crypto.getRandomValues(lastRandom)
  }
  return encodeTime(nowMs) + encodeRandom(lastRandom)
}

/** Test-only: forget the monotonic state so runs are independent. */
export function __resetUlidForTests(): void {
  lastTime = -1
  lastRandom = new Uint8Array(10)
}
