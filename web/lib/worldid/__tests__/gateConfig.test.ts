/**
 * gateConfig.test.ts — the per-merchant toggle store + gate resolution
 * (World ID ADR D0 / D2 / unit 3).
 *
 * Pins:
 *   - the branding row stores the D0 choice (checkoutMode/humanVerifier) and
 *     defaults to 'standard'/'offchain' (nothing breaks for existing tenants),
 *   - resolveGate enforces D0 mutual exclusion (exactly one mode out),
 *   - verified-human FAILS SOFT to standard when World ID is unconfigured
 *     (a missing env never blocks pay — ADR D7),
 *   - verified-human stays verified-human when configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the chains seam the store/response transitively pulls (mirrors the
// branding route test) and let us flip World ID configured on/off per case.
vi.mock('@/lib/chains', () => ({
  getDefaultChainId: () => 5042002,
  getRouterAddress: () => '0xRouter0000000000000000000000000000000099',
  getUsdcAddress: () => '0xUsdc00000000000000000000000000000000aaaa',
}))

const store = await import('@/lib/branding/store')
const config = await import('@/lib/worldid/config')
const { resolveGate } = await import('@/lib/worldid/gateConfig')

const TENANT = '0x' + 'c'.repeat(40)

beforeEach(() => {
  store.__resetBrandingStore()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('tenant_branding stores the D0 choice', () => {
  it('defaults to standard / offchain for a fresh row (nothing breaks)', () => {
    const row = store.upsertBranding({ tenantId: TENANT, displayName: 'Acme' })
    expect(row.checkoutMode).toBe('standard')
    expect(row.humanVerifier).toBe('offchain')
    expect(row.verifiedOperator).toBe(false)
  })

  it('persists a verified-human choice and preserves it across a branding edit', () => {
    store.upsertBranding({ tenantId: TENANT, displayName: 'Acme', checkoutMode: 'verified-human' })
    // A later edit that omits the mode must KEEP it (preserve-on-omit).
    const edited = store.upsertBranding({ tenantId: TENANT, displayName: 'Acme Renamed' })
    expect(edited.checkoutMode).toBe('verified-human')
    expect(edited.displayName).toBe('Acme Renamed')
  })

  it('persists a private choice', () => {
    const row = store.upsertBranding({ tenantId: TENANT, displayName: 'Acme', checkoutMode: 'private' })
    expect(row.checkoutMode).toBe('private')
  })

  it('coerces a junk mode value to the safe default', () => {
    const row = store.upsertBranding({
      tenantId: TENANT,
      displayName: 'Acme',
      checkoutMode: 'nonsense' as never,
    })
    expect(row.checkoutMode).toBe('standard')
  })
})

describe('resolveGate — D0 mutual exclusion + fail-soft', () => {
  it('null branding → standard', () => {
    const g = resolveGate(null)
    expect(g.mode).toBe('standard')
    expect(g.degradedToStandard).toBe(false)
  })

  it('private passes through (never mounts the World ID gate)', () => {
    const g = resolveGate({ checkoutMode: 'private' })
    expect(g.mode).toBe('private')
  })

  it('verified-human DEGRADES to standard when World ID is unconfigured (ADR D7)', () => {
    vi.spyOn(config, 'isWorldIdConfigured').mockReturnValue(false)
    const g = resolveGate({ checkoutMode: 'verified-human' })
    expect(g.mode).toBe('standard')
    expect(g.degradedToStandard).toBe(true)
  })

  it('verified-human stays verified-human when World ID is configured', () => {
    vi.spyOn(config, 'isWorldIdConfigured').mockReturnValue(true)
    const g = resolveGate({ checkoutMode: 'verified-human', humanVerifier: 'offchain' })
    expect(g.mode).toBe('verified-human')
    expect(g.verifier).toBe('offchain')
    expect(g.degradedToStandard).toBe(false)
  })

  it('carries the onchain verifier sub-choice through', () => {
    vi.spyOn(config, 'isWorldIdConfigured').mockReturnValue(true)
    const g = resolveGate({ checkoutMode: 'verified-human', humanVerifier: 'onchain' })
    expect(g.verifier).toBe('onchain')
  })
})
