/**
 * dashboard-receipts.test.ts — pins the two things the receipts read must get
 * right without a browser: (1) the subgraph path is fail-soft and dormant-safe,
 * and (2) the chain fallback is BOUNDED — it never issues fromBlock:'earliest'
 * (the silent-empty footgun on range-capped RPCs) and stops early once it has
 * enough, newest-first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'
import {
  fetchReceiptsFromChain,
  fetchReceiptsFromSubgraph,
  loadReceipts,
  subgraphUrl,
} from './dashboard-receipts'

const ROUTER = '0xe92244e3368561faf21648146511DeDE3a475EB5' as Address
const ENV_KEY = 'NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL'

afterEach(() => {
  delete process.env[ENV_KEY]
  vi.unstubAllGlobals()
})

// A synthetic viem PaymentReceived log at a given block.
function mkLog(block: bigint, tag: number) {
  return {
    transactionHash: `0x${tag.toString(16).padStart(64, '0')}`,
    blockNumber: block,
    args: {
      buyer: `0x${tag.toString(16).padStart(40, '0')}` as Address,
      grossAmount: BigInt(tag) * 1_000_000n,
      usdAmount8: BigInt(tag) * 100_000_000n,
    },
  }
}

// A fake client whose getLogs answers from a (fromBlock,toBlock)->logs function,
// recording every window it was asked for so we can assert the bounds.
function fakeClient(
  latest: bigint,
  answer: (from: bigint, to: bigint) => ReturnType<typeof mkLog>[],
  windows: Array<{ from: bigint; to: bigint }>,
): PublicClient {
  return {
    getBlockNumber: async () => latest,
    getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) => {
      windows.push({ from: args.fromBlock, to: args.toBlock })
      return answer(args.fromBlock, args.toBlock)
    },
  } as unknown as PublicClient
}

describe('subgraphUrl', () => {
  it('is dormant (undefined) when the env is unset or blank', () => {
    expect(subgraphUrl()).toBeUndefined()
    process.env[ENV_KEY] = '   '
    expect(subgraphUrl()).toBeUndefined()
  })

  it('returns the trimmed url when set', () => {
    process.env[ENV_KEY] = '  https://api.studio.thegraph.com/query/x/access0x1/v1  '
    expect(subgraphUrl()).toBe('https://api.studio.thegraph.com/query/x/access0x1/v1')
  })
})

describe('fetchReceiptsFromSubgraph', () => {
  it('returns null (defers to chain) when no subgraph is configured', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect(await fetchReceiptsFromSubgraph(1n)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('parses a good response into newest-first rows', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            payments: [
              {
                transactionHash: '0xaa',
                buyer: '0xbuyer1',
                grossAmount: '100',
                usdAmount8: '200',
                blockNumber: '99',
              },
            ],
          },
        }),
      })),
    )
    const rows = await fetchReceiptsFromSubgraph(7n)
    expect(rows).not.toBeNull()
    expect(rows![0]).toEqual({
      txHash: '0xaa',
      buyer: '0xbuyer1',
      gross: 100n,
      usd8: 200n,
      block: 99n,
    })
  })

  it('fail-softs to null on GraphQL errors', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ errors: [{ message: 'bad field' }] }),
      })),
    )
    expect(await fetchReceiptsFromSubgraph(7n)).toBeNull()
  })

  it('fail-softs to null when fetch throws', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    expect(await fetchReceiptsFromSubgraph(7n)).toBeNull()
  })
})

describe('fetchReceiptsFromChain (bounded)', () => {
  it('never queries fromBlock:"earliest" and keeps every window under the RPC cap', async () => {
    const windows: Array<{ from: bigint; to: bigint }> = []
    // No logs anywhere → it must exhaust its window budget, not one giant query.
    const client = fakeClient(1_000_000n, () => [], windows)
    await fetchReceiptsFromChain(client, ROUTER, 1n)
    expect(windows.length).toBeGreaterThan(1)
    for (const w of windows) {
      expect(typeof w.from).toBe('bigint') // never the string 'earliest'
      expect(w.to - w.from).toBeLessThanOrEqual(1800n)
      expect(w.from).toBeGreaterThanOrEqual(0n)
    }
  })

  it('stops after the first window once it already has 50, newest-first', async () => {
    const windows: Array<{ from: bigint; to: bigint }> = []
    // The newest window returns 60 logs at ascending blocks 900_941..1_000_000.
    const client = fakeClient(
      1_000_000n,
      (from, to) =>
        to === 1_000_000n
          ? Array.from({ length: 60 }, (_, i) => mkLog(from + BigInt(i), i + 1))
          : [],
      windows,
    )
    const rows = await fetchReceiptsFromChain(client, ROUTER, 1n)
    expect(rows).toHaveLength(50)
    expect(windows).toHaveLength(1) // stopped early
    // Newest-first: block[0] is the largest.
    expect(rows[0].block).toBeGreaterThan(rows[49].block)
  })

  it('scans backward across windows for sparse history', async () => {
    const windows: Array<{ from: bigint; to: bigint }> = []
    // A single old payment ~3 windows back.
    const target = 1_000_000n - 1800n * 3n - 10n
    const client = fakeClient(
      1_000_000n,
      (from, to) => (target >= from && target <= to ? [mkLog(target, 42)] : []),
      windows,
    )
    const rows = await fetchReceiptsFromChain(client, ROUTER, 1n)
    expect(rows).toHaveLength(1)
    expect(rows[0].block).toBe(target)
    expect(windows.length).toBeGreaterThanOrEqual(4)
  })
})

describe('loadReceipts (source selection)', () => {
  it('uses the chain when no subgraph is configured', async () => {
    const windows: Array<{ from: bigint; to: bigint }> = []
    const client = fakeClient(2000n, (from, to) => (to === 2000n ? [mkLog(1999n, 5)] : []), windows)
    const rows = await loadReceipts(client, ROUTER, 1n)
    expect(rows).toHaveLength(1)
    expect(windows.length).toBeGreaterThan(0) // the chain path ran
  })

  it('uses the subgraph when configured and never touches the chain', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: { payments: [{ transactionHash: '0xff', buyer: '0x1', grossAmount: '1', usdAmount8: '2', blockNumber: '5' }] },
        }),
      })),
    )
    const windows: Array<{ from: bigint; to: bigint }> = []
    const client = fakeClient(2000n, () => [], windows)
    const rows = await loadReceipts(client, ROUTER, 1n)
    expect(rows).toHaveLength(1)
    expect(rows[0].txHash).toBe('0xff')
    expect(windows).toHaveLength(0) // chain never queried
  })
})
