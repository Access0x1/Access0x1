/**
 * @file provenanceRegistry.test.ts — locks the pure admin helpers.
 *
 * The load-bearing assertion: the `repoId` this admin page derives MUST equal the
 * exact bytes32 NFTeria's `lib/provenance.ts` derives — otherwise a claim made
 * from the admin page would not match what NFTeria reads back. We pin both the
 * source string and the derived hash so a drift in either fails CI loudly.
 *
 * Also covers the testnet-only gate, the cid / bytes32 validators, and the revert
 * humanizer — all pure, no network, no wallet.
 */
import { describe, expect, it } from 'vitest'
import { keccak256, toBytes } from 'viem'
import { baseSepolia, optimismSepolia, arbitrumSepolia, mainnet, base } from 'viem/chains'
import {
  NFTERIA_REPO_STRING,
  NFTERIA_REPO_ID,
  deriveNfteriaRepoId,
  ARC_TESTNET_ID,
  ADMIN_TESTNET_CHAINS,
  isAdminTestnetChain,
  getAdminChain,
  isBytes32,
  isNonEmptyCid,
  validateAnchorInput,
  humanizeAdminRevert,
  adminTxUrl,
  adminAddressUrl,
} from './provenanceRegistry'

describe('NFTeria repoId derivation', () => {
  // The exact string NFTeria's lib/provenance.ts hashes — duplicated here so a
  // change to either copy is caught.
  const EXPECTED_STRING = 'github.com/doble196/fleet#apps/nfteria'
  // keccak256(toBytes(EXPECTED_STRING)) — the bytes32 the registry stores under.
  const EXPECTED_ID = '0x226f19ebabfb9d4f91a21e574d06c87dbfceeeadd28a550bfd93dbfe06057067'

  it('uses the same documented repo string as NFTeria', () => {
    expect(NFTERIA_REPO_STRING).toBe(EXPECTED_STRING)
  })

  it('derives the stable, NFTeria-matching repoId', () => {
    expect(deriveNfteriaRepoId()).toBe(EXPECTED_ID)
    expect(NFTERIA_REPO_ID).toBe(EXPECTED_ID)
  })

  it('matches an independent keccak256(toBytes(string)) computation', () => {
    expect(deriveNfteriaRepoId()).toBe(keccak256(toBytes(NFTERIA_REPO_STRING)))
  })
})

describe('testnet-only chain gate', () => {
  it('exposes exactly the four required testnets', () => {
    const ids = ADMIN_TESTNET_CHAINS.map((c) => c.chain.id).sort((a, b) => a - b)
    expect(ids).toEqual(
      [ARC_TESTNET_ID, baseSepolia.id, optimismSepolia.id, arbitrumSepolia.id].sort(
        (a, b) => a - b,
      ),
    )
  })

  it('accepts the allowed testnet ids', () => {
    expect(isAdminTestnetChain(ARC_TESTNET_ID)).toBe(true)
    expect(isAdminTestnetChain(baseSepolia.id)).toBe(true)
    expect(isAdminTestnetChain(optimismSepolia.id)).toBe(true)
    expect(isAdminTestnetChain(arbitrumSepolia.id)).toBe(true)
  })

  it('rejects mainnet ids and nullish input', () => {
    expect(isAdminTestnetChain(mainnet.id)).toBe(false)
    expect(isAdminTestnetChain(base.id)).toBe(false)
    expect(isAdminTestnetChain(undefined)).toBe(false)
    expect(isAdminTestnetChain(null)).toBe(false)
    expect(isAdminTestnetChain(999999)).toBe(false)
  })

  it('every advertised admin chain is a testnet (no mainnet leaks in)', () => {
    for (const { chain } of ADMIN_TESTNET_CHAINS) {
      expect(chain.testnet).toBe(true)
    }
  })

  it('resolves an admin chain by id, null for an unknown id', () => {
    expect(getAdminChain(baseSepolia.id)?.label).toBe('Base Sepolia')
    expect(getAdminChain(mainnet.id)).toBeNull()
  })
})

describe('isBytes32', () => {
  it('accepts 0x + exactly 64 hex chars', () => {
    expect(isBytes32(`0x${'a'.repeat(64)}`)).toBe(true)
    expect(isBytes32(`0x${'0'.repeat(64)}`)).toBe(true)
    expect(isBytes32(`0x${'F'.repeat(64)}`)).toBe(true)
  })

  it('rejects wrong length, missing prefix, or non-hex', () => {
    expect(isBytes32(`0x${'a'.repeat(63)}`)).toBe(false)
    expect(isBytes32(`0x${'a'.repeat(65)}`)).toBe(false)
    expect(isBytes32('a'.repeat(64))).toBe(false)
    expect(isBytes32(`0x${'g'.repeat(64)}`)).toBe(false)
    expect(isBytes32('')).toBe(false)
  })

  it('tolerates surrounding whitespace', () => {
    expect(isBytes32(`  0x${'a'.repeat(64)}  `)).toBe(true)
  })
})

describe('isNonEmptyCid', () => {
  it('accepts any non-blank string', () => {
    expect(isNonEmptyCid('bafy...')).toBe(true)
    expect(isNonEmptyCid(' x ')).toBe(true)
  })

  it('rejects empty / whitespace-only', () => {
    expect(isNonEmptyCid('')).toBe(false)
    expect(isNonEmptyCid('   ')).toBe(false)
  })
})

describe('validateAnchorInput', () => {
  const root = `0x${'b'.repeat(64)}`

  it('returns cleaned input when valid', () => {
    const res = validateAnchorInput('  bafyCID  ', '  v1.0.0  ', `  ${root}  `)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value).toEqual({ cid: 'bafyCID', tag: 'v1.0.0', merkleRoot: root })
    }
  })

  it('fails on an empty cid', () => {
    const res = validateAnchorInput('', 'v1', root)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/content id/i)
  })

  it('fails on a malformed merkle root', () => {
    const res = validateAnchorInput('cid', 'v1', '0x1234')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/bytes32/i)
  })

  it('allows an empty tag (optional)', () => {
    const res = validateAnchorInput('cid', '', root)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.tag).toBe('')
  })
})

describe('humanizeAdminRevert', () => {
  it('maps a known registry custom error to a friendly line', () => {
    const err = new Error('execution reverted: Access0x1ProvenanceRegistry__RepoAlreadyClaimed(...)')
    expect(humanizeAdminRevert(err)).toMatch(/already claimed/i)
  })

  it('maps NotRepoOwner', () => {
    const err = new Error('Access0x1ProvenanceRegistry__NotRepoOwner(0x..., 0x...)')
    expect(humanizeAdminRevert(err)).toMatch(/claimed this repo/i)
  })

  it('detects a user-rejected request', () => {
    expect(humanizeAdminRevert(new Error('User rejected the request.'))).toMatch(/rejected/i)
  })

  it('detects insufficient funds', () => {
    expect(humanizeAdminRevert(new Error('insufficient funds for gas'))).toMatch(/insufficient/i)
  })

  it('prefers a viem shortMessage when no known error matches', () => {
    const err = { message: 'long\nmultiline\nblob', shortMessage: 'Nonce too low.' }
    expect(humanizeAdminRevert(err)).toBe('Nonce too low.')
  })

  it('falls back to the first line of a raw message', () => {
    expect(humanizeAdminRevert(new Error('first line\nsecond line'))).toBe('first line')
  })
})

describe('explorer link helpers', () => {
  it('builds a tx url on a chain with a known explorer', () => {
    expect(adminTxUrl(baseSepolia.id, '0xabc')).toBe('https://sepolia.basescan.org/tx/0xabc')
  })

  it('builds an address url on a chain with a known explorer', () => {
    expect(adminAddressUrl(arbitrumSepolia.id, '0xdef')).toBe(
      'https://sepolia.arbiscan.io/address/0xdef',
    )
  })

  it('returns null for a non-admin chain (no invented link)', () => {
    expect(adminTxUrl(mainnet.id, '0xabc')).toBeNull()
    expect(adminAddressUrl(mainnet.id, '0xabc')).toBeNull()
  })
})
