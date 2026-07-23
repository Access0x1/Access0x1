import { describe, it, expect, afterEach } from 'vitest'
import { baseSepolia, sepolia, zksyncSepoliaTestnet } from 'viem/chains'
import { ARC_TESTNET_ID, resolveCheckoutChainId } from '../lib/chains.js'
import { slugSettlementChainId, toPublicBranding } from '../lib/branding/response.js'
import type { TenantBranding } from '../lib/branding/store.js'

/** A minimal on-chain-registered branding row; override only what a test cares about. */
function brandingRow(overrides: Partial<TenantBranding>): TenantBranding {
  return {
    tenantId: '0x' + 'a'.repeat(40),
    displayName: 'Acme',
    description: '',
    logoUrl: null,
    logoSvgInline: '',
    brandColor: '#000000',
    checkoutSlug: 'acme',
    merchantId: '7',
    merchantChainId: null,
    nameHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
    logoBlobId: null,
    checkoutMode: 'standard',
    humanVerifier: 'offchain',
    requiredTier: 'standard',
    vertical: 'standard',
    verifiedOperator: false,
    operatorNullifier: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

/**
 * The hosted checkout reads its settlement chain from an optional, UNTRUSTED
 * `?chainId=` link param so a link can reach a merchant on a non-default mirror
 * chain (e.g. the live `active` merchant #1 on Base Sepolia while the default is
 * Ethereum Sepolia). The param is validated, never trusted: honored only for a SUPPORTED chain
 * that resolves a router; anything else falls back to the default — never a wrong
 * or unconfigured chain, and never a throw (law #4).
 */
describe('resolveCheckoutChainId', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID
  })

  it('falls back to the default (Ethereum Sepolia) when the param is absent/blank', () => {
    expect(resolveCheckoutChainId(null)).toBe(sepolia.id)
    expect(resolveCheckoutChainId(undefined)).toBe(sepolia.id)
    expect(resolveCheckoutChainId('')).toBe(sepolia.id)
    expect(resolveCheckoutChainId('   ')).toBe(sepolia.id)
  })

  it('honors a supported, mirror-routed chain (Base Sepolia 84532 — the live merchant chain)', () => {
    expect(resolveCheckoutChainId(String(baseSepolia.id))).toBe(baseSepolia.id)
    expect(resolveCheckoutChainId(' 84532 ')).toBe(baseSepolia.id) // trimmed
  })

  it('honors Ethereum Sepolia (11155111 — mirror deployed + now a supported chain)', () => {
    expect(resolveCheckoutChainId(String(sepolia.id))).toBe(sepolia.id)
  })

  it('rejects a non-numeric / non-integer / non-positive param → default', () => {
    expect(resolveCheckoutChainId('abc')).toBe(sepolia.id)
    expect(resolveCheckoutChainId('84532abc')).toBe(sepolia.id)
    expect(resolveCheckoutChainId('84532.5')).toBe(sepolia.id)
    expect(resolveCheckoutChainId('0')).toBe(sepolia.id)
    expect(resolveCheckoutChainId('-1')).toBe(sepolia.id)
  })

  it('rejects an unsupported chain id → default (never a chain the app cannot handle)', () => {
    expect(resolveCheckoutChainId('999999')).toBe(sepolia.id)
  })

  it('rejects a supported-but-router-less chain (zkSync Sepolia, no mirror + no env) → default', () => {
    // 300 is in SUPPORTED_CHAINS but NOT mirror-deployed and has no env router,
    // so getRouterAddress throws — there is nothing to pay against.
    expect(resolveCheckoutChainId(String(zksyncSepoliaTestnet.id))).toBe(sepolia.id)
  })

  it('the fallback tracks NEXT_PUBLIC_DEFAULT_CHAIN_ID when it is set', () => {
    process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID = String(baseSepolia.id)
    expect(resolveCheckoutChainId('abc')).toBe(baseSepolia.id) // invalid param → the (now Base) default
  })
})

/**
 * The two checkout views resolve their settlement chain DIFFERENTLY, on purpose —
 * this pins the security boundary between them.
 *
 * `/m/[merchantId]` is fully URL-driven (merchantId + name come from the link, the
 * on-chain MerchantIdentity is the trust anchor), so a per-link `?chainId=` is a
 * legitimate multichain feature → resolveCheckoutChainId honors it.
 *
 * `/c/<slug>` is SERVER-AUTHORITATIVE: the slug maps to one merchant on one chain,
 * and the branding (name/logo/color) is unspoofable. Honoring `?chainId=` there
 * would let /c/<slug>?chainId=<attacker-chain> keep the real branding while paying
 * an impostor merchant (registerMerchant is permissionless + ids are sequential),
 * so the slug settles ONLY on the payload's chain → slugSettlementChainId ignores
 * any URL input entirely.
 */
describe('slugSettlementChainId — branded slug settles server-authoritatively', () => {
  it('returns the payload chainId (the slug binding), not a URL param', () => {
    expect(slugSettlementChainId({ chainId: baseSepolia.id })).toBe(baseSepolia.id)
    expect(slugSettlementChainId({ chainId: ARC_TESTNET_ID })).toBe(ARC_TESTNET_ID)
    expect(slugSettlementChainId({ chainId: sepolia.id })).toBe(sepolia.id)
  })

  it('regression: a ?chainId= that the /m/ resolver WOULD honor must NOT move a slug payout', () => {
    // The /m/ view would settle on the attacker's chain if given ?chainId=84532…
    expect(resolveCheckoutChainId(String(baseSepolia.id))).toBe(baseSepolia.id)
    // …but a slug pinned to Arc settles on Arc regardless of any URL input. The
    // slug's chain is a pure function of the server payload — the URL cannot reach it.
    expect(slugSettlementChainId({ chainId: ARC_TESTNET_ID })).toBe(ARC_TESTNET_ID)
  })
})

/**
 * The settlement chain in the public payload is the merchant's REAL registration
 * chain (persisted at attach-on-chain), NOT the app's build-time default. Since the
 * mirror shares one router address across chains and merchant ids are per-chain +
 * permissionless, a global default would route a plain `/c/<slug>` (no query params)
 * to a same-id impostor on the default chain. Binding to the registration chain
 * closes that; a legacy row (no chain recorded) still falls back to the default.
 */
describe('toPublicBranding — settlement chain binds to the merchant registration chain', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID
  })

  it('returns the merchant registration chain, so the slug settles there', () => {
    const pub = toPublicBranding(brandingRow({ merchantChainId: baseSepolia.id }))
    expect(pub.chainId).toBe(baseSepolia.id)
    expect(slugSettlementChainId(pub)).toBe(baseSepolia.id)
  })

  it('a merchant on a non-default chain is NOT settled on the default (the redirect gap)', () => {
    process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID = String(ARC_TESTNET_ID) // default = Arc
    const pub = toPublicBranding(brandingRow({ merchantChainId: sepolia.id }))
    expect(pub.chainId).toBe(sepolia.id) // the merchant's chain, not Arc
    expect(pub.chainId).not.toBe(ARC_TESTNET_ID)
  })

  it('falls back to the default chain for a legacy row (no merchantChainId)', () => {
    process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID = String(baseSepolia.id)
    const pub = toPublicBranding(brandingRow({ merchantChainId: null }))
    expect(pub.chainId).toBe(baseSepolia.id)
  })
})
