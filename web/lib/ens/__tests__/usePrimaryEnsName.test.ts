/**
 * @file usePrimaryEnsName.test.ts — the primary-ENS-name client read.
 *
 * The hook's React state/effect mirrors the covered MerchantIdentity pattern
 * (cancelled-flag guard). What's NEW and worth pinning is the fetch behavior,
 * which the hook delegates to the pure {@link fetchPrimaryEnsName}: no address ⇒
 * NO fetch and null; an address ⇒ GET /api/ens/primary and read `{ name }`; and
 * every failure mode (non-2xx, network throw, missing/blank name) ⇒ null so the
 * caller falls back to the address. `fetch` is stubbed so the suite is offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchPrimaryEnsName } from '../usePrimaryEnsName'

const ADDR = '0x7d3a48269416507e6d207a9449e7800971823ffa'

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
  const fn = vi.fn((input: RequestInfo | URL) => Promise.resolve(impl(String(input))))
  vi.stubGlobal('fetch', fn)
  return fn
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('fetchPrimaryEnsName', () => {
  it('does NOT fetch when no address is given (dormant ⇒ null)', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ name: 'nope.eth' }))
    expect(await fetchPrimaryEnsName(undefined)).toBeNull()
    expect(await fetchPrimaryEnsName('')).toBeNull()
    expect(await fetchPrimaryEnsName('   ')).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('GETs /api/ens/primary with the address and returns the name', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ name: 'yourname.eth' }))
    expect(await fetchPrimaryEnsName(ADDR)).toBe('yourname.eth')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      `/api/ens/primary?address=${encodeURIComponent(ADDR)}`,
    )
  })

  it('returns null when the server reports no primary name', async () => {
    mockFetch(() => jsonResponse({ name: null }))
    expect(await fetchPrimaryEnsName(ADDR)).toBeNull()
  })

  it('returns null on a non-2xx response (fail-soft)', async () => {
    mockFetch(() => jsonResponse({ name: 'ignored.eth' }, false))
    expect(await fetchPrimaryEnsName(ADDR)).toBeNull()
  })

  it('returns null (never throws) when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    )
    await expect(fetchPrimaryEnsName(ADDR)).resolves.toBeNull()
  })

  it('treats an empty-string name as no name', async () => {
    mockFetch(() => jsonResponse({ name: '' }))
    expect(await fetchPrimaryEnsName(ADDR)).toBeNull()
  })
})
