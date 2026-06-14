/**
 * operatorVerify.route.test.ts — POST /api/branding/operator-verify (Casino
 * vertical, World prize). The operator proves personhood with World ID and the
 * route records verifiedOperator + operatorNullifier on the branding row, which
 * is the load-bearing step that lets a casino go live.
 *
 * The Developer-Portal fetch is STUBBED (no network / booth credentials). Pins:
 *   - happy path: a valid proof flips verifiedOperator true + stores the
 *     nullifier, AND a casino that was previously un-saveable now saves,
 *   - no_branding (400) when the tenant has not set a name/logo yet,
 *   - one-human-per-operator: a reused nullifier → 409 already_verified,
 *   - not_configured (503) when World ID env is unset — CANNOT verify (fail-soft).
 *
 * The chains seam is mocked (the store transitively pulls it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chains', () => ({
  getDefaultChainId: () => 5042002,
  getRouterAddress: () => '0xRouter0000000000000000000000000000000099',
  getUsdcAddress: () => '0xUsdc00000000000000000000000000000000aaaa',
}))

// Configure the operator action + rp id so the route is "switched on" without
// real Developer-Portal values. worldRpId() drives verifyWorldProof's config gate.
vi.mock('@/lib/worldid/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worldid/config')>()
  return {
    ...actual,
    worldRpId: () => 'rp_test_op',
    worldOperatorAction: () => 'verified-operator',
    worldVerifyBase: () => 'https://staging-developer.worldcoin.org',
  }
})

const { POST } = await import('../operator-verify/route.js')
const store = await import('@/lib/branding/store')
const nullifierStore = await import('@/lib/worldid/nullifierStore')

const TENANT = '0x' + 'f'.repeat(40)

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('https://x/api/branding/operator-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function proof(nullifier: string): Record<string, unknown> {
  return {
    tenantId: TENANT,
    action: 'verified-operator',
    nonce: 'abc',
    proof: [1, 2, 3],
    merkle_root: '0xroot',
    nullifier,
  }
}

let fetchSpy: ReturnType<typeof vi.fn>
function stubPortal(impl: (url: string) => Response): void {
  fetchSpy = vi.fn(async (input: unknown) => impl(String(input)))
  vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
}

beforeEach(() => {
  store.__resetBrandingStore()
  nullifierStore.__resetNullifierStore()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/branding/operator-verify — records the operator badge', () => {
  it('flips verifiedOperator true + stores the nullifier on a valid proof', async () => {
    store.upsertBranding({ tenantId: TENANT, displayName: 'Lucky Spin' })
    stubPortal(() =>
      new Response(JSON.stringify({ success: true, nullifier: '0x2a', action: 'verified-operator' }), {
        status: 200,
      }),
    )
    const res = await post(proof('0x2a'))
    expect(res.status).toBe(200)
    const row = store.getByTenant(TENANT)
    expect(row?.verifiedOperator).toBe(true)
    expect(row?.operatorNullifier).toBe('0x2a')
    // Confirms the operator action endpoint, not the buyer one.
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/v4/verify/rp_test_op')
  })

  it('lets a casino go live AFTER operator verification (was blocked before)', async () => {
    store.upsertBranding({ tenantId: TENANT, displayName: 'Lucky Spin' })
    // Before: the casino save is blocked.
    expect(() =>
      store.upsertBranding({ tenantId: TENANT, displayName: 'Lucky Spin', vertical: 'casino' }),
    ).toThrowError(expect.objectContaining({ code: store.CASINO_NEEDS_OPERATOR_CODE }))

    stubPortal(() =>
      new Response(JSON.stringify({ success: true, nullifier: '0x3b', action: 'verified-operator' }), {
        status: 200,
      }),
    )
    await post(proof('0x3b'))

    // After: the casino saves and is forced verified-human.
    const casino = store.upsertBranding({
      tenantId: TENANT,
      displayName: 'Lucky Spin',
      vertical: 'casino',
    })
    expect(casino.vertical).toBe('casino')
    expect(casino.checkoutMode).toBe('verified-human')
    expect(casino.verifiedOperator).toBe(true)
  })
})

describe('POST /api/branding/operator-verify — guards', () => {
  it('400 no_branding when the tenant has no row yet', async () => {
    stubPortal(() => new Response(JSON.stringify({ success: true, nullifier: '0x9' }), { status: 200 }))
    const res = await post(proof('0x9'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('no_branding')
  })

  it('409 already_verified when the same human verifies an operator twice', async () => {
    store.upsertBranding({ tenantId: TENANT, displayName: 'Lucky Spin' })
    stubPortal(() =>
      new Response(JSON.stringify({ success: true, nullifier: '0xd0c', action: 'verified-operator' }), {
        status: 200,
      }),
    )
    expect((await post(proof('0xd0c'))).status).toBe(200)
    expect((await post(proof('0xd0c'))).status).toBe(409)
  })

  it('503 not_configured when World ID env is unset — CANNOT verify (fail-soft)', async () => {
    // Re-point worldRpId to empty for this case so verifyWorldProof short-circuits.
    const config = await import('@/lib/worldid/config')
    vi.spyOn(config, 'worldRpId').mockReturnValue('')
    store.upsertBranding({ tenantId: TENANT, displayName: 'Lucky Spin' })
    const res = await post(proof('0x1'))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('not_configured')
    // Nothing was recorded — the badge is never faked.
    expect(store.getByTenant(TENANT)?.verifiedOperator).toBe(false)
  })
})
