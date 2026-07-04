/**
 * @file primary.route.test.ts — the /api/ens/primary READ route.
 *
 * Pins: GET returns the verified primary name when one resolves; returns
 * { name: null } when verifiedPrimaryName yields null; returns { name: null }
 * (no lib call) for a bad/missing address; NEVER 500s and NEVER throws even when
 * the lib rejects; and calls verifiedPrimaryName on MAINNET (chain id 1) — the
 * identity namespace — not the settlement chain. lib/ens is mocked so the suite
 * is offline and never touches an RPC or env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifiedPrimaryName = vi.fn()
vi.mock('@/lib/ens', () => ({
  verifiedPrimaryName: (address: string, chainId: number, rpcUrl?: string) =>
    verifiedPrimaryName(address, chainId, rpcUrl),
}))

const { GET } = await import('../route.js')

// A distinct address per test avoids the route's in-memory per-address cache
// leaking a prior result into the next assertion.
let counter = 0
function freshAddress(): string {
  counter += 1
  return '0x' + counter.toString(16).padStart(40, '0')
}

function get(address?: string): Request {
  const url = new URL('https://x/api/ens/primary')
  if (address !== undefined) url.searchParams.set('address', address)
  return new Request(url)
}

beforeEach(() => {
  verifiedPrimaryName.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/ens/primary', () => {
  it('returns the verified primary name when one resolves', async () => {
    const addr = freshAddress()
    verifiedPrimaryName.mockResolvedValue('acme.eth')
    const res = await GET(get(addr))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'acme.eth' })
  })

  it('resolves the primary name on MAINNET (chain id 1), not the settlement chain', async () => {
    const addr = freshAddress()
    verifiedPrimaryName.mockResolvedValue('acme.eth')
    await GET(get(addr))
    expect(verifiedPrimaryName).toHaveBeenCalledWith(addr, 1, undefined)
  })

  it('returns { name: null } when no primary name is set', async () => {
    const addr = freshAddress()
    verifiedPrimaryName.mockResolvedValue(null)
    const res = await GET(get(addr))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: null })
  })

  it('returns { name: null } for a bad address WITHOUT calling the lib', async () => {
    const res = await GET(get('not-an-address'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: null })
    expect(verifiedPrimaryName).not.toHaveBeenCalled()
  })

  it('returns { name: null } for a missing address param WITHOUT calling the lib', async () => {
    const res = await GET(get(undefined))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: null })
    expect(verifiedPrimaryName).not.toHaveBeenCalled()
  })

  it('NEVER 500s / throws even when the lib rejects (fail-soft)', async () => {
    const addr = freshAddress()
    verifiedPrimaryName.mockRejectedValue(new Error('rpc exploded'))
    const res = await GET(get(addr))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: null })
  })

  it('caches per-address (a second call within TTL does not re-hit the lib)', async () => {
    const addr = freshAddress()
    verifiedPrimaryName.mockResolvedValue('cached.eth')
    const first = await GET(get(addr))
    expect(await first.json()).toEqual({ name: 'cached.eth' })
    const second = await GET(get(addr))
    expect(await second.json()).toEqual({ name: 'cached.eth' })
    expect(verifiedPrimaryName).toHaveBeenCalledTimes(1)
  })
})
