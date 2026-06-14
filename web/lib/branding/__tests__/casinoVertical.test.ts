/**
 * casinoVertical.test.ts — the Casino vertical makes World ID load-bearing
 * (World prize). Pins, at the ONE write path (`upsertBranding`):
 *
 *   - a casino FORCES checkoutMode to 'verified-human' (players must pass the
 *     World ID gate) — not operator-overridable while vertical = casino,
 *   - a casino save is BLOCKED until the operator is World ID-verified
 *     (verifiedOperator) — the "what breaks without World ID" answer,
 *   - once the operator is verified, the casino saves and persists,
 *   - a standard merchant is COMPLETELY unaffected (default vertical, free mode),
 *   - vertical defaults to 'standard' and coerces junk safely (non-breaking).
 *
 * Mocks the chains seam the store transitively pulls (mirrors the gateConfig /
 * branding route tests) so the store can be imported in the node env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chains', () => ({
  getDefaultChainId: () => 5042002,
  getRouterAddress: () => '0xRouter0000000000000000000000000000000099',
  getUsdcAddress: () => '0xUsdc00000000000000000000000000000000aaaa',
}))

const store = await import('@/lib/branding/store')

const TENANT = '0x' + 'd'.repeat(40)
const OTHER = '0x' + 'e'.repeat(40)

beforeEach(() => {
  store.__resetBrandingStore()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('vertical defaults + narrowing (non-breaking)', () => {
  it('a fresh row defaults to vertical = standard', () => {
    const row = store.upsertBranding({ tenantId: TENANT, displayName: 'Acme' })
    expect(row.vertical).toBe('standard')
  })

  it('asVertical coerces junk to standard and recognizes casino', () => {
    expect(store.asVertical('casino')).toBe('casino')
    expect(store.asVertical('STANDARD')).toBe('standard')
    expect(store.asVertical('nonsense')).toBe('standard')
    expect(store.asVertical(undefined)).toBe('standard')
    expect(store.isCasino('casino')).toBe(true)
    expect(store.isCasino('standard')).toBe(false)
  })
})

describe('casino BLOCKS save without an operator World ID verification', () => {
  it('throws CASINO_NEEDS_OPERATOR when verifiedOperator is not set', () => {
    expect(() =>
      store.upsertBranding({ tenantId: TENANT, displayName: 'Lucky Spin', vertical: 'casino' }),
    ).toThrowError(
      expect.objectContaining({ code: store.CASINO_NEEDS_OPERATOR_CODE }),
    )
    // And nothing was persisted — the casino did NOT go live.
    expect(store.getByTenant(TENANT)).toBeNull()
  })

  it('still blocks even if the caller tries to force verified-human directly', () => {
    expect(() =>
      store.upsertBranding({
        tenantId: TENANT,
        displayName: 'Lucky Spin',
        vertical: 'casino',
        checkoutMode: 'verified-human',
      }),
    ).toThrowError(expect.objectContaining({ code: store.CASINO_NEEDS_OPERATOR_CODE }))
  })
})

describe('casino FORCES verified-human and saves once the operator is verified', () => {
  it('a verified operator saves the casino and it is verified-human', () => {
    const row = store.upsertBranding({
      tenantId: TENANT,
      displayName: 'Lucky Spin',
      vertical: 'casino',
      verifiedOperator: true,
      operatorNullifier: '12345',
    })
    expect(row.vertical).toBe('casino')
    expect(row.checkoutMode).toBe('verified-human')
    expect(row.verifiedOperator).toBe(true)
    expect(row.operatorNullifier).toBe('12345')
  })

  it('IGNORES an attempt to override the mode to standard/private while casino', () => {
    const live = store.upsertBranding({
      tenantId: TENANT,
      displayName: 'Lucky Spin',
      vertical: 'casino',
      verifiedOperator: true,
    })
    expect(live.checkoutMode).toBe('verified-human')

    // Operator tries to relax the gate to 'private' but stays a casino → ignored.
    const stillForced = store.upsertBranding({
      tenantId: TENANT,
      displayName: 'Lucky Spin',
      checkoutMode: 'private',
    })
    expect(stillForced.vertical).toBe('casino')
    expect(stillForced.checkoutMode).toBe('verified-human')
  })

  it('leaving the casino vertical lets the operator pick any mode again', () => {
    store.upsertBranding({
      tenantId: TENANT,
      displayName: 'Lucky Spin',
      vertical: 'casino',
      verifiedOperator: true,
    })
    const relaxed = store.upsertBranding({
      tenantId: TENANT,
      displayName: 'Lucky Spin',
      vertical: 'standard',
      checkoutMode: 'standard',
    })
    expect(relaxed.vertical).toBe('standard')
    expect(relaxed.checkoutMode).toBe('standard')
  })
})

describe('standard merchants are UNAFFECTED', () => {
  it('a standard merchant saves with no operator verification and keeps its chosen mode', () => {
    const row = store.upsertBranding({
      tenantId: OTHER,
      displayName: 'Joe Barbershop',
      checkoutMode: 'standard',
    })
    expect(row.vertical).toBe('standard')
    expect(row.checkoutMode).toBe('standard')
    expect(row.verifiedOperator).toBe(false)
  })

  it('a standard merchant can still pick verified-human or private freely', () => {
    const vh = store.upsertBranding({
      tenantId: OTHER,
      displayName: 'Joe Barbershop',
      checkoutMode: 'verified-human',
    })
    expect(vh.checkoutMode).toBe('verified-human')
    expect(vh.verifiedOperator).toBe(false) // no operator block off the casino path

    const pv = store.upsertBranding({
      tenantId: OTHER,
      displayName: 'Joe Barbershop',
      checkoutMode: 'private',
    })
    expect(pv.checkoutMode).toBe('private')
  })
})
