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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseBroadcastChainDir,
  parseBroadcastData,
  chainMeta,
  resolveArtifact,
} from '../scripts/gen-deployments.mjs'

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

describe('parseBroadcastChainDir — a config run must never erase a chain', () => {
  const CREATE_RUN = (name: string, address: string) => ({
    transactions: [{ transactionType: 'CREATE', contractName: name, contractAddress: address }],
  })
  const CALL_ONLY_RUN = {
    transactions: [
      { transactionType: 'CALL', function: 'setConfig(uint256)' },
      { transactionType: 'CALL', function: 'seedPromo(bytes32)' },
    ],
  }

  const write = (dir: string, name: string, data: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(data))

  it('falls back to the newest DEPLOY run when run-latest is call-only (the Base Sepolia regression)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-'))
    write(dir, 'run-1000.json', CREATE_RUN('Access0x1Router', '0xAaA1'))
    write(dir, 'run-latest.json', CALL_ONLY_RUN) // a later config run overwrote latest
    expect(parseBroadcastChainDir(dir)).toEqual([
      { contractName: 'Access0x1Router', address: '0xaaa1' },
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  it('prefers run-latest when it DOES contain deployments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-'))
    write(dir, 'run-1000.json', CREATE_RUN('Access0x1Router', '0xOld1'))
    write(dir, 'run-latest.json', CREATE_RUN('Access0x1Router', '0xNew2'))
    expect(parseBroadcastChainDir(dir)).toEqual([
      { contractName: 'Access0x1Router', address: '0xnew2' },
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  it('walks history newest-first — the latest deployful run wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-'))
    write(dir, 'run-1000.json', CREATE_RUN('Access0x1Router', '0xOld1'))
    write(dir, 'run-2000.json', CREATE_RUN('Access0x1Router', '0xNew2'))
    write(dir, 'run-latest.json', CALL_ONLY_RUN)
    expect(parseBroadcastChainDir(dir)).toEqual([
      { contractName: 'Access0x1Router', address: '0xnew2' },
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips a corrupt history file rather than dying, and keeps walking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-'))
    write(dir, 'run-1000.json', CREATE_RUN('Access0x1Router', '0xAaA1'))
    writeFileSync(join(dir, 'run-2000.json'), '{not json') // corrupt newest
    write(dir, 'run-latest.json', CALL_ONLY_RUN)
    expect(parseBroadcastChainDir(dir)).toEqual([
      { contractName: 'Access0x1Router', address: '0xaaa1' },
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns [] when no run on the chain ever deployed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-'))
    write(dir, 'run-latest.json', CALL_ONLY_RUN)
    expect(parseBroadcastChainDir(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('parseBroadcastChainDir — union across history (add-on deploys keep the base)', () => {
  it('merges an add-on deploy run WITH the earlier full deploy (per-name, later wins)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-'))
    writeFileSync(
      join(dir, 'run-1000.json'),
      JSON.stringify({
        transactions: [
          { transactionType: 'CREATE', contractName: 'Access0x1Router', contractAddress: '0xAaA1' },
          { transactionType: 'CREATE', contractName: 'Access0x1Escrow', contractAddress: '0xBbB2' },
        ],
      }),
    )
    // The add-on run deploys ONE new module and re-deploys the Router.
    writeFileSync(
      join(dir, 'run-2000.json'),
      JSON.stringify({
        transactions: [
          { transactionType: 'CREATE', contractName: 'Access0x1Rebates', contractAddress: '0xCcC3' },
          { transactionType: 'CREATE', contractName: 'Access0x1Router', contractAddress: '0xDdD4' },
        ],
      }),
    )
    writeFileSync(
      join(dir, 'run-latest.json'),
      JSON.stringify({ transactions: [{ transactionType: 'CALL', function: 'setConfig(uint256)' }] }),
    )
    expect(parseBroadcastChainDir(dir)).toEqual([
      { contractName: 'Access0x1Escrow', address: '0xbbb2' }, // kept from the full deploy
      { contractName: 'Access0x1Rebates', address: '0xccc3' }, // added by the add-on
      { contractName: 'Access0x1Router', address: '0xddd4' }, // later run overrides per name
    ])
    rmSync(dir, { recursive: true, force: true })
  })
})
