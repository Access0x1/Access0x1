/**
 * @file gen-deployments.test.ts — the broadcast parser + chain-meta resolver.
 *
 * The Deployments dashboard is only as honest as the maps the generator vendors.
 * This exercises the REAL exported logic of scripts/gen-deployments.mjs against
 * fixtures: that it keeps CREATE txs, NAMES the nameless CREATE3-mirror
 * additionalContracts via the manifest map (dropping the CreateX shims), skips
 * CALLs and nameless/addressless entries, lets the last entry for a name win,
 * lower-cases addresses, resolves a name to its bytecode artifact, and resolves
 * chain display metadata (name/explorer) from viem with no invented explorer.
 */
import { describe, expect, it } from 'vitest'
import { parseBroadcastData, chainMeta, resolveArtifact } from '../scripts/gen-deployments.mjs'

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

describe('parseBroadcastData — CREATE3 mirror via additionalContracts', () => {
  // A two-entry slice of the canonical mirror manifest (address -> label).
  const mirror = new Map([
    ['0xe92244e3368561faf21648146511dede3a475eb5', 'Access0x1Router.proxy'],
    ['0x3336ec82d865e8bd1f9054856ac22b45a71207db', 'Access0x1Router.impl'],
  ])

  it('names CreateX additionalContracts via the manifest + drops the shims', () => {
    const out = parseBroadcastData(
      {
        transactions: [
          {
            transactionType: 'CALL', // the CreateX factory call — itself never a product contract
            additionalContracts: [
              // a CreateX CREATE2 proxy shim — NOT in the manifest, must be dropped
              { transactionType: 'CREATE2', contractName: null, address: '0x11D8dc74C09941248De5fe5690d0AAd350f70952' },
              // the Router proxy + impl — named (and lower-cased) via the manifest
              { transactionType: 'CREATE3', contractName: null, address: '0xE92244e3368561fAF21648146511DeDE3a475EB5' },
              { transactionType: 'CREATE3', contractName: null, address: '0x3336Ec82D865E8Bd1f9054856ac22B45a71207DB' },
            ],
          },
        ],
      },
      mirror,
    )
    expect(out).toEqual([
      { contractName: 'Access0x1Router.impl', address: '0x3336ec82d865e8bd1f9054856ac22b45a71207db' },
      { contractName: 'Access0x1Router.proxy', address: '0xe92244e3368561faf21648146511dede3a475eb5' },
    ])
  })

  it('ignores additionalContracts when no mirror map is given (legacy default)', () => {
    const out = parseBroadcastData({
      transactions: [
        {
          transactionType: 'CALL',
          additionalContracts: [
            { transactionType: 'CREATE3', contractName: null, address: '0xE92244e3368561fAF21648146511DeDE3a475EB5' },
          ],
        },
      ],
    })
    expect(out).toEqual([])
  })
})

describe('resolveArtifact — deployment name -> bytecode artifact', () => {
  it('maps a .impl label to its own contract artifact', () => {
    expect(resolveArtifact('Access0x1Router.impl')).toBe('Access0x1Router')
  })

  it('maps any .proxy label to the shared OpenZeppelin ERC1967Proxy artifact', () => {
    expect(resolveArtifact('Access0x1Router.proxy')).toBe('ERC1967Proxy')
    expect(resolveArtifact('PaymentLanes.proxy')).toBe('ERC1967Proxy')
  })

  it('leaves a legacy / standalone name unchanged', () => {
    expect(resolveArtifact('Access0x1Router')).toBe('Access0x1Router')
    expect(resolveArtifact('ERC1967Proxy')).toBe('ERC1967Proxy')
    expect(resolveArtifact('Access0x1Receiver')).toBe('Access0x1Receiver')
  })
})
