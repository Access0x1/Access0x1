/**
 * @file merchantId.test.ts — the dashboard merchant-id resolver.
 *
 * The dashboard resolves the on-chain merchant id from TWO sources and PREFERS
 * the durable branding row over the per-browser localStorage cache, so a
 * merchant who switched on payments on one device sees receipts on another.
 */
import { describe, expect, it } from 'vitest'
import { resolveMerchantId } from '../merchantId'

describe('resolveMerchantId — prefers the durable branding row', () => {
  it('prefers the branding row over localStorage when both are present', () => {
    expect(resolveMerchantId('42', '7')).toBe('42')
  })

  it('falls back to localStorage when the branding row has no merchantId', () => {
    expect(resolveMerchantId(null, '7')).toBe('7')
    expect(resolveMerchantId(undefined, '7')).toBe('7')
    expect(resolveMerchantId('', '7')).toBe('7')
    expect(resolveMerchantId('   ', '7')).toBe('7')
  })

  it('uses the branding row even when localStorage is empty', () => {
    expect(resolveMerchantId('42', null)).toBe('42')
    expect(resolveMerchantId('42', '')).toBe('42')
  })

  it('returns null when neither source has a usable id', () => {
    expect(resolveMerchantId(null, null)).toBeNull()
    expect(resolveMerchantId(undefined, undefined)).toBeNull()
    expect(resolveMerchantId('', '')).toBeNull()
    expect(resolveMerchantId('  ', '  ')).toBeNull()
  })

  it('trims surrounding whitespace on the chosen value', () => {
    expect(resolveMerchantId(' 42 ', null)).toBe('42')
    expect(resolveMerchantId(null, ' 7 ')).toBe('7')
  })
})
