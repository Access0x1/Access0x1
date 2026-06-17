/**
 * @file withdraw.route.test.ts — the Gateway withdraw endpoint (money path).
 *
 * Pins the guardrails: only the verified seller wallet may withdraw (401 with no
 * valid tenant, 403 for any other wallet), the body is validated (amount, chain,
 * recipient), a balance pre-check runs BEFORE the signed tx (off-CEI), and a clean
 * request returns the mint tx hash. The GatewayClient is injected via the route's
 * test seam so the suite is offline and signs nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Booth-gated tenant resolution: a valid 0x body.tenantId resolves to that wallet,
// anything else throws TenantAuthError (→ 401), mirroring the unconfigured fallback.
vi.mock('@/lib/branding/tenant', () => {
  class TenantAuthError extends Error {}
  return {
    TenantAuthError,
    resolveVerifiedTenant: vi.fn(async (_req: Request, body: { tenantId?: string }) => {
      const id = (body?.tenantId ?? '').toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(id)) throw new TenantAuthError('no tenant')
      return { tenantId: id, verified: false }
    }),
  }
})

const { POST, __setWithdrawClientFactory } = await import('../route.js')

const SELLER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const RECIPIENT = '0x3333333333333333333333333333333333333333'

/** A withdraw client double: ample balance, records the withdraw call. */
function okClient(available = '100') {
  const withdraw = vi.fn(async () => ({ mintTxHash: '0xdeadbeef' }))
  const getBalances = vi.fn(async () => ({ gateway: { formattedAvailable: available } }))
  return { withdraw, getBalances }
}

function req(body: Record<string, unknown>): Request {
  return new Request('http://x/api/gateway/withdraw', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.SELLER_ADDRESS = SELLER
})
afterEach(() => {
  __setWithdrawClientFactory(null)
  vi.clearAllMocks()
})

describe('POST /api/gateway/withdraw', () => {
  it('401 when the caller is not an authenticated tenant', async () => {
    const res = await POST(req({ amount: '5', destinationChain: 'baseSepolia', recipient: RECIPIENT }))
    expect(res.status).toBe(401)
  })

  it('403 when the verified wallet is not the seller', async () => {
    const res = await POST(
      req({ tenantId: OTHER, amount: '5', destinationChain: 'baseSepolia', recipient: RECIPIENT }),
    )
    expect(res.status).toBe(403)
  })

  it('400 on an invalid amount', async () => {
    __setWithdrawClientFactory(() => okClient())
    const res = await POST(
      req({ tenantId: SELLER, amount: '0', destinationChain: 'baseSepolia', recipient: RECIPIENT }),
    )
    expect(res.status).toBe(400)
  })

  it('400 on an unsupported destination chain', async () => {
    __setWithdrawClientFactory(() => okClient())
    const res = await POST(
      req({ tenantId: SELLER, amount: '5', destinationChain: 'notachain', recipient: RECIPIENT }),
    )
    expect(res.status).toBe(400)
  })

  it('400 on an invalid recipient address', async () => {
    __setWithdrawClientFactory(() => okClient())
    const res = await POST(
      req({ tenantId: SELLER, amount: '5', destinationChain: 'baseSepolia', recipient: 'nope' }),
    )
    expect(res.status).toBe(400)
  })

  it('400 when the balance pre-check is short (no signed tx)', async () => {
    const client = okClient('1') // only 1 USDC available, withdrawing 5
    __setWithdrawClientFactory(() => client)
    const res = await POST(
      req({ tenantId: SELLER, amount: '5', destinationChain: 'baseSepolia', recipient: RECIPIENT }),
    )
    expect(res.status).toBe(400)
    expect(client.withdraw).not.toHaveBeenCalled() // never signed
  })

  it('200 returns the mint tx hash for the seller with sufficient balance', async () => {
    const client = okClient('100')
    __setWithdrawClientFactory(() => client)
    const res = await POST(
      req({ tenantId: SELLER, amount: '5', destinationChain: 'baseSepolia', recipient: RECIPIENT }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mintTxHash: '0xdeadbeef' })
    expect(client.withdraw).toHaveBeenCalledWith('5', {
      chain: 'baseSepolia',
      recipient: RECIPIENT,
    })
  })
})
