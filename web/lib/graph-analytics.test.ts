/**
 * graph-analytics.test.ts — pins that the network leaderboard read is dormant
 * when unconfigured, parses a good response (including the `_meta` honesty
 * fields), and fails soft to `null` on every GraphQL/network/shape problem —
 * it must never throw into an analytics-only view.
 *
 * Mirrors the existing colocated-test idiom in dashboard-receipts.test.ts and
 * rail-seams.test.ts: env var stubbed via process.env directly, fetch stubbed
 * via vi.stubGlobal, afterEach cleanup, dormant/fail-soft-to-null pinned explicitly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LEADERBOARD_LIMIT,
  fetchMerchantLeaderboard,
  isNetworkLeaderboardActive,
} from './graph-analytics'

const ENV_KEY = 'NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL'

afterEach(() => {
  delete process.env[ENV_KEY]
  vi.unstubAllGlobals()
})

describe('isNetworkLeaderboardActive', () => {
  it('is false when the subgraph env is unset or blank', () => {
    expect(isNetworkLeaderboardActive()).toBe(false)
    process.env[ENV_KEY] = '   '
    expect(isNetworkLeaderboardActive()).toBe(false)
  })

  it('is true once a subgraph url is configured', () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    expect(isNetworkLeaderboardActive()).toBe(true)
  })
})

describe('fetchMerchantLeaderboard', () => {
  it('resolves to null (no chain fallback exists) when no subgraph is configured', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect(await fetchMerchantLeaderboard()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('parses a good response, including _meta honesty fields', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            merchants: [
              { merchantId: '7', paymentCount: '12', totalUsd8: '500000000', lastPaymentAt: '1752700000' },
              { merchantId: '3', paymentCount: '4', totalUsd8: '100000000', lastPaymentAt: '1752600000' },
            ],
            _meta: { block: { number: 43900000 }, hasIndexingErrors: false },
          },
        }),
      })),
    )
    const result = await fetchMerchantLeaderboard(2)
    expect(result).not.toBeNull()
    expect(result!.merchants).toHaveLength(2)
    expect(result!.merchants[0]).toEqual({
      merchantId: 7n,
      paymentCount: 12n,
      totalUsd8: 500_000_000n,
      lastPaymentAt: 1_752_700_000n,
    })
    expect(result!.asOfBlock).toBe(43_900_000n)
    expect(result!.hasIndexingErrors).toBe(false)
  })

  it('surfaces hasIndexingErrors:true rather than hiding a degraded index', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: { merchants: [], _meta: { block: { number: 1 }, hasIndexingErrors: true } },
        }),
      })),
    )
    const result = await fetchMerchantLeaderboard()
    expect(result).not.toBeNull()
    expect(result!.hasIndexingErrors).toBe(true)
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
    expect(await fetchMerchantLeaderboard()).toBeNull()
  })

  it('fail-softs to null on a non-ok HTTP response', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    expect(await fetchMerchantLeaderboard()).toBeNull()
  })

  it('fail-softs to null when fetch throws', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    expect(await fetchMerchantLeaderboard()).toBeNull()
  })

  it('clamps the requested limit into the bounded 1..50 range', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    const seen: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body).variables.first)
        return { ok: true, json: async () => ({ data: { merchants: [], _meta: null } }) }
      }),
    )
    await fetchMerchantLeaderboard(999)
    await fetchMerchantLeaderboard(0)
    expect(seen[0]).toBe(50)
    expect(seen[1]).toBe(1)
  })

  it('defaults to DEFAULT_LEADERBOARD_LIMIT when called with no argument', async () => {
    process.env[ENV_KEY] = 'https://subgraph.example/q'
    const seen: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body).variables.first)
        return { ok: true, json: async () => ({ data: { merchants: [], _meta: null } }) }
      }),
    )
    await fetchMerchantLeaderboard()
    expect(seen[0]).toBe(DEFAULT_LEADERBOARD_LIMIT)
  })
})
