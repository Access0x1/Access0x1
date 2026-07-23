/**
 * ensv2.test.ts — the ENSv2 live payment-record source (the CCIP-Read resolver's
 * off-chain twin). Proves: records are COMPUTED LIVE from the router read (not a
 * stored row); an unregistered seat (owner 0) yields null, never a fake address; an
 * unconfigured chain fails soft to null; the text schema matches the on-chain
 * resolver's `click.access0x1.*` keys; and the env gate flips the ENSv2 seam on/off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toCoinType } from '@/lib/ens'

const ROUTER = '0x00000000000000000000000000000000000000aa'
const PAYOUT = '0x00000000000000000000000000000000000000bb'
const OWNER = '0x00000000000000000000000000000000000000cc'
const ZERO = '0x0000000000000000000000000000000000000000'
const CHAIN_ID = 84_532 // Base Sepolia

// Mock the chain + router seams so no network is touched. getMerchant is the single
// live read the resolver mirrors; we drive it per-test.
const getMerchantMock = vi.fn()
vi.mock('@/lib/contracts', () => ({ getMerchant: (...a: unknown[]) => getMerchantMock(...a) }))
vi.mock('@/lib/chains', () => ({
  getRouterAddress: (chainId: number) => {
    if (chainId !== CHAIN_ID) throw new Error('no router for chain')
    return ROUTER
  },
  getChain: (id: number) => ({
    id,
    name: 'test',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://localhost:8545'] } },
  }),
  getRpcUrl: () => 'http://localhost:8545',
}))

// Import AFTER mocks are registered.
import {
  ensV2Config,
  isEnsV2Configured,
  PAYMENT_TEXT_KEYS,
  paymentResolverAddress,
  resolvePaymentRecords,
  resolveRecord,
} from '@/lib/ens/ensv2'

function registeredMerchant() {
  return { payout: PAYOUT, owner: OWNER, feeRecipient: ZERO, feeBps: 0, active: true, nameHash: '0x00' }
}

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.NEXT_PUBLIC_ENSV2_ROOT_REGISTRY
  delete process.env.NEXT_PUBLIC_ENSV2_ETH_REGISTRY
  delete process.env[`NEXT_PUBLIC_ENSV2_RESOLVER_${CHAIN_ID}`]
})

describe('resolvePaymentRecords — live records from the router', () => {
  it('computes payout + coinType + click.access0x1.* text from a registered seat', async () => {
    getMerchantMock.mockResolvedValue(registeredMerchant())
    const records = await resolvePaymentRecords(CHAIN_ID, 42n)
    expect(records).not.toBeNull()
    expect(records!.payout).toBe(PAYOUT)
    expect(records!.coinType).toBe(toCoinType(CHAIN_ID))
    expect(records!.texts[PAYMENT_TEXT_KEYS.merchantId]).toBe('42')
    expect(records!.texts[PAYMENT_TEXT_KEYS.router]).toBe(ROUTER)
    expect(records!.texts[PAYMENT_TEXT_KEYS.chainId]).toBe(String(CHAIN_ID))
    expect(records!.texts[PAYMENT_TEXT_KEYS.pricingCurrency]).toBe('USD')
    expect(records!.texts[PAYMENT_TEXT_KEYS.payout]).toBe(PAYOUT)
  })

  it('returns null for a never-registered seat (owner 0) — never a fake address', async () => {
    getMerchantMock.mockResolvedValue({ ...registeredMerchant(), owner: ZERO })
    expect(await resolvePaymentRecords(CHAIN_ID, 7n)).toBeNull()
  })

  it('returns null (fail-soft) for a chain with no router configured', async () => {
    expect(await resolvePaymentRecords(999_999, 1n)).toBeNull()
    expect(getMerchantMock).not.toHaveBeenCalled()
  })

  it('returns null (fail-soft) when the router read throws', async () => {
    getMerchantMock.mockRejectedValue(new Error('rpc down'))
    expect(await resolvePaymentRecords(CHAIN_ID, 1n)).toBeNull()
  })
})

describe('resolveRecord — single addr/text answer', () => {
  it('returns the payout when no key is given', async () => {
    getMerchantMock.mockResolvedValue(registeredMerchant())
    expect(await resolveRecord(CHAIN_ID, 42n)).toBe(PAYOUT)
  })

  it('returns a known text value and null for an unknown key', async () => {
    getMerchantMock.mockResolvedValue(registeredMerchant())
    expect(await resolveRecord(CHAIN_ID, 42n, PAYMENT_TEXT_KEYS.pricingCurrency)).toBe('USD')
    expect(await resolveRecord(CHAIN_ID, 42n, 'com.example.unknown')).toBeNull()
  })

  it('returns null for an unregistered seat', async () => {
    getMerchantMock.mockResolvedValue({ ...registeredMerchant(), owner: ZERO })
    expect(await resolveRecord(CHAIN_ID, 7n)).toBeNull()
  })
})

describe('ENSv2 env gate', () => {
  it('is off when the registries are unset', () => {
    expect(isEnsV2Configured()).toBe(false)
    expect(ensV2Config().rootRegistry).toBeNull()
  })

  it('is on when both registries are set', () => {
    process.env.NEXT_PUBLIC_ENSV2_ROOT_REGISTRY = ROUTER
    process.env.NEXT_PUBLIC_ENSV2_ETH_REGISTRY = OWNER
    expect(isEnsV2Configured()).toBe(true)
  })

  it('reads the per-chain resolver pointer from env, null when unset', () => {
    expect(paymentResolverAddress(CHAIN_ID)).toBeNull()
    process.env[`NEXT_PUBLIC_ENSV2_RESOLVER_${CHAIN_ID}`] = PAYOUT
    expect(paymentResolverAddress(CHAIN_ID)).toBe(PAYOUT)
  })
})
