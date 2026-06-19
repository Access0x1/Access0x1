/**
 * @file gen-deployments.test.ts — the broadcast parser + chain-meta resolver.
 *
 * The Deployments dashboard is only as honest as the maps the generator vendors.
 * This exercises the REAL exported logic of scripts/gen-deployments.mjs against
 * fixtures: that it keeps only CREATE txs, skips CALLs and nameless/addressless
 * entries, lets the last CREATE for a name win, lower-cases addresses, and
 * resolves chain display metadata (name/explorer) from viem with no invented
 * explorer for an unknown chain.
 */
import { describe, expect, it } from 'vitest'
import { parseBroadcastData, chainMeta } from '../scripts/gen-deployments.mjs'

describe('parseBroadcastData — CREATE txs only', () => {
  it('keeps CREATE deployments and drops CALL txs', () => {
    const out = parseBroadcastData({
      transactions: [
        { transactionType: 'CREATE', contractName: 'Access0x1Router', contractAddress: '0xAaA1' },
        { transactionType: 'CALL', contractName: 'Access0x1Router', contractAddress: '0xBbB2' },
        { transactionType: 'CREATE', contractName: 'PaymentLanes', contractAddress: '0xCcC3' },
      ],
    })
    expect(out).toEqual([
      { contractName: 'Access0x1Router', address: '0xaaa1' },
      { contractName: 'PaymentLanes', address: '0xccc3' },
    ])
  })

  it('skips entries missing a name or address', () => {
    const out = parseBroadcastData({
      transactions: [
        { transactionType: 'CREATE', contractAddress: '0xDdD4' }, // no name
        { transactionType: 'CREATE', contractName: 'Nameless' }, // no address
        { transactionType: 'CREATE', contractName: 'Good', contractAddress: '0xEeE5' },
      ],
    })
    expect(out).toEqual([{ contractName: 'Good', address: '0xeee5' }])
  })

  it('lets the LAST CREATE for a name win (most-recent address)', () => {
    const out = parseBroadcastData({
      transactions: [
        { transactionType: 'CREATE', contractName: 'Access0x1Router', contractAddress: '0x1111' },
        { transactionType: 'CREATE', contractName: 'Access0x1Router', contractAddress: '0x2222' },
      ],
    })
    expect(out).toEqual([{ contractName: 'Access0x1Router', address: '0x2222' }])
  })

  it('returns [] for an empty / missing transactions list', () => {
    expect(parseBroadcastData({})).toEqual([])
    expect(parseBroadcastData({ transactions: [] })).toEqual([])
  })
})

describe('chainMeta — display metadata from viem, no invented explorer', () => {
  it('resolves Base Sepolia name + explorer from the viem chain object', () => {
    const meta = chainMeta(84532)
    expect(meta.name).toBe('Base Sepolia')
    expect(meta.explorer).toBe('https://sepolia.basescan.org')
  })

  it('describes Arc Testnet inline with no explorer deep-link (law #4)', () => {
    const meta = chainMeta(5042002)
    expect(meta.name).toBe('Arc Testnet')
    expect(meta.explorer).toBeUndefined()
  })

  it('falls back to a stub with no explorer for an unknown chain', () => {
    const meta = chainMeta(99999999)
    expect(meta.name).toBe('Chain 99999999')
    expect(meta.explorer).toBeUndefined()
  })
})
