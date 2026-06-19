/**
 * @file bytecode-diff.test.ts — the deploy-verification compare core.
 *
 * Proves the load-bearing logic of the Deployments dashboard:
 *   1. stripMetadata removes a canonical solc CBOR tail, leaves clean code alone.
 *   2. zeroImmutables neutralizes constructor-baked immutables.
 *   3. hashOnchainCode is stable + matches a known fixture.
 *   4. diffContract -> MATCHES when the on-chain hash == the current build, and
 *      -> DRIFTED when it differs (the redeploy signal), plus NO-CODE / UNKNOWN.
 *
 * Fixtures are exact, machine-computed (see the hashes asserted below) so a
 * regression in the strip/zero/hash pipeline fails here, not silently in the UI.
 */
import { describe, expect, it, vi } from 'vitest'
import { keccak256 } from 'viem'

// A controlled CURRENT_BYTECODE so the MATCHES/DRIFTED assertions are exact and
// do not drift when the real contracts are rebuilt. Two entries:
//   - WithImmutable: code that has a 32-byte immutable at byte 4; its codeHash is
//     the hash of the ZEROED form, so on-chain code with a baked value must match.
//   - Plain: no immutables; codeHash is the hash of its clean runtime code.
const PLAIN_CODE = '60806040'
const PLAIN_HASH = keccak256(`0x${PLAIN_CODE}`)
const IMM_ARTIFACT = '60806040' + '00'.repeat(32) + '5b600080' // immutables zeroed
const IMM_HASH = keccak256(`0x${IMM_ARTIFACT}`)

vi.mock('../lib/currentBytecode', () => ({
  CURRENT_BYTECODE: {
    Plain: { codeHash: PLAIN_HASH, immutableRanges: [] },
    WithImmutable: { codeHash: IMM_HASH, immutableRanges: [[4, 32]] },
  },
}))

const { stripMetadata, zeroImmutables, hashOnchainCode, diffContract } = await import(
  '../lib/bytecodeDiff.js'
)

describe('stripMetadata — removes a solc CBOR tail iff present', () => {
  // 60806040 + a264 ipfs(32 zero) solc 0.8.16 0033 ; cbor length = 0x0033 = 51.
  const WITH_META =
    '60806040a2646970667358220000000000000000000000000000000000000000000000000000000000000000000064736f6c63430008100033'

  it('strips the canonical a264…0033 metadata tail', () => {
    expect(stripMetadata(WITH_META)).toBe('60806040')
  })

  it('leaves metadata-less code unchanged (this repo builds cbor_metadata=false)', () => {
    // The real Router/PaymentLanes tails end in plain opcodes, no a264 header.
    expect(stripMetadata('60806040ecc55f00')).toBe('60806040ecc55f00')
  })

  it('does not truncate when the final 2 bytes parse as a length but the region is not a264', () => {
    // Last 2 bytes = 0x0002, but the 4 bytes back are "5f00" not "a264".
    expect(stripMetadata('6080604000005f000002')).toBe('6080604000005f000002')
  })

  it('returns very short input unchanged', () => {
    expect(stripMetadata('60')).toBe('60')
  })
})

describe('zeroImmutables — neutralizes constructor-baked immutables', () => {
  it('zeroes the [start,length] byte ranges', () => {
    const onchain = '60806040' + 'ff'.repeat(32) + '5b600080'
    expect(zeroImmutables(onchain, [[4, 32]])).toBe('60806040' + '00'.repeat(32) + '5b600080')
  })

  it('is a no-op when there are no ranges', () => {
    expect(zeroImmutables('deadbeef', [])).toBe('deadbeef')
  })
})

describe('hashOnchainCode — stable, strips+zeroes, matches the artifact hash', () => {
  it('hashes clean code to the plain fixture hash', () => {
    expect(hashOnchainCode('0x60806040', [])).toBe(PLAIN_HASH)
  })

  it('on-chain code with a baked immutable hashes to the zeroed-artifact hash', () => {
    const onchain = '0x60806040' + 'ff'.repeat(32) + '5b600080'
    expect(hashOnchainCode(onchain, [[4, 32]])).toBe(IMM_HASH)
  })

  it('is case-insensitive on the input hex', () => {
    expect(hashOnchainCode('0x60806040', [])).toBe(hashOnchainCode('0X60806040', []))
  })
})

describe('diffContract — the per-cell verdict', () => {
  it('MATCHES when the deployed code equals the current build (no immutables)', () => {
    expect(diffContract('Plain', '0x60806040')).toBe('MATCHES')
  })

  it('MATCHES a contract WITH immutables despite a baked on-chain value', () => {
    const onchain = '0x60806040' + 'ff'.repeat(32) + '5b600080'
    expect(diffContract('WithImmutable', onchain)).toBe('MATCHES')
  })

  it('DRIFTED when the deployed code differs from the current build', () => {
    expect(diffContract('Plain', '0xdeadbeef')).toBe('DRIFTED')
  })

  it('NO-CODE when the address has empty bytecode', () => {
    expect(diffContract('Plain', '0x')).toBe('NO-CODE')
    expect(diffContract('Plain', undefined)).toBe('NO-CODE')
  })

  it('UNKNOWN when no current-build fingerprint exists for the contract name', () => {
    expect(diffContract('NotBuilt', '0x60806040')).toBe('UNKNOWN')
  })
})
