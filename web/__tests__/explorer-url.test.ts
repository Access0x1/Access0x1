/**
 * @file explorer-url.test.ts — block-explorer link policy for lib/chains.ts.
 *
 * Law #4 (truth in copy): a tx hash links ONLY to a real, verifiable testnet
 * explorer. Chains without a booth-confirmed explorer (Arc) must return
 * `undefined` so the UI renders plain text instead of an invented/broken link.
 */
import { describe, expect, it } from 'vitest'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'
import { explorerTxUrl, ARC_TESTNET_ID } from '../lib/chains.js'

const HASH = '0xabc123'

describe('explorerTxUrl — verifiable explorers only (law #4)', () => {
  it('Base Sepolia -> sepolia.basescan.org/tx/<hash>', () => {
    expect(explorerTxUrl(baseSepolia.id, HASH)).toBe(`https://sepolia.basescan.org/tx/${HASH}`)
  })

  it('ZKsync Sepolia -> sepolia.explorer.zksync.io/tx/<hash>', () => {
    expect(explorerTxUrl(zksyncSepoliaTestnet.id, HASH)).toBe(
      `https://sepolia.explorer.zksync.io/tx/${HASH}`,
    )
  })

  it('Arc Testnet -> undefined (explorer not booth-confirmed)', () => {
    expect(explorerTxUrl(ARC_TESTNET_ID, HASH)).toBeUndefined()
  })

  it('unknown chain -> undefined', () => {
    expect(explorerTxUrl(999999, HASH)).toBeUndefined()
  })
})
