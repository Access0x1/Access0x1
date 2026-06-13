/**
 * store.test.ts — the tenant_branding model + store (ADR unit 1 / D3 Tier 1).
 *
 * Pins the non-coder defaults and the multi-tenant invariants: auto-slug from
 * the name, slug uniqueness (with -2/-3 suggestions), name-hash in lockstep with
 * the name, description/name sanitization, brand-color re-validation, and the
 * by-slug / by-merchant lookups the public endpoints depend on.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetBrandingStore,
  attachOnChain,
  BrandingError,
  getByMerchantId,
  getBySlug,
  getByTenant,
  isSlugAvailable,
  isValidSlug,
  nameHashOf,
  normalizeName,
  sanitizeDescription,
  sanitizeDisplayName,
  slugify,
  suggestSlugs,
  upsertBranding,
} from '@/lib/branding/store'
import { keccak256, toHex } from 'viem'

const TENANT_A = '0x' + 'a'.repeat(40)
const TENANT_B = '0x' + 'b'.repeat(40)

beforeEach(() => {
  __resetBrandingStore()
})

describe('normalization helpers', () => {
  it('slugify lowercases, hyphenates, trims, strips diacritics', () => {
    expect(slugify("Joe's Barbershop")).toBe('joe-s-barbershop')
    expect(slugify('  Café  Olé! ')).toBe('cafe-ole')
    expect(slugify('---')).toBe('')
  })

  it('isValidSlug enforces shape + length', () => {
    expect(isValidSlug('joes-barbershop')).toBe(true)
    expect(isValidSlug('a')).toBe(false) // too short
    expect(isValidSlug('-bad')).toBe(false)
    expect(isValidSlug('Bad-Caps')).toBe(false)
    expect(isValidSlug('has space')).toBe(false)
  })

  it('normalizeName + nameHashOf match RegisterForm keccak256(toHex(name))', () => {
    expect(normalizeName('  Joe   Barber ')).toBe('Joe Barber')
    // RegisterForm hashes the trimmed name; ours hashes the whitespace-collapsed
    // form — identical when there is no internal double-space.
    expect(nameHashOf('Joe Barber')).toBe(keccak256(toHex('Joe Barber')))
  })

  it('sanitizeDescription / sanitizeDisplayName strip markup + clamp', () => {
    expect(sanitizeDescription('<b>hi</b> there')).toBe('hi there')
    expect(sanitizeDescription('a'.repeat(200)).length).toBe(140)
    expect(sanitizeDisplayName('<script>X</script> Shop')).toBe('X Shop')
  })
})

describe('upsertBranding — create', () => {
  it('auto-derives a unique slug from the name, sets defaults', () => {
    const row = upsertBranding({ tenantId: TENANT_A, displayName: "Joe's Barbershop" })
    expect(row.checkoutSlug).toBe('joe-s-barbershop')
    expect(row.brandColor).toMatch(/^#[0-9A-F]{6}$/)
    expect(row.merchantId).toBeNull()
    expect(row.logoBlobId).toBeNull()
    expect(row.nameHash).toBe(nameHashOf("Joe's Barbershop"))
  })

  it('rejects an empty name', () => {
    expect(() => upsertBranding({ tenantId: TENANT_A, displayName: '   ' })).toThrow(BrandingError)
  })

  it('rejects a missing tenant', () => {
    expect(() => upsertBranding({ tenantId: '', displayName: 'X' })).toThrow(BrandingError)
  })

  it('a second tenant with the same name gets a -2 slug', () => {
    upsertBranding({ tenantId: TENANT_A, displayName: 'Acme' })
    const b = upsertBranding({ tenantId: TENANT_B, displayName: 'Acme' })
    expect(b.checkoutSlug).toBe('acme-2')
  })

  it('an explicit slug already taken by ANOTHER tenant throws SLUG_TAKEN', () => {
    upsertBranding({ tenantId: TENANT_A, displayName: 'Acme', checkoutSlug: 'acme' })
    try {
      upsertBranding({ tenantId: TENANT_B, displayName: 'Other', checkoutSlug: 'acme' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BrandingError)
      expect((err as BrandingError).code).toBe('SLUG_TAKEN')
    }
  })

  it('re-validates a junk brand color to the safe default', () => {
    const row = upsertBranding({
      tenantId: TENANT_A,
      displayName: 'X',
      brandColor: 'red;evil',
    })
    expect(row.brandColor).toMatch(/^#[0-9A-F]{6}$/)
  })
})

describe('upsertBranding — edit (idempotent per tenant)', () => {
  it('keeps the slug + on-chain anchors across an edit that omits them', () => {
    upsertBranding({ tenantId: TENANT_A, displayName: 'Acme', checkoutSlug: 'acme' })
    attachOnChain(TENANT_A, { merchantId: '7', logoBlobId: 'blob123' })
    const edited = upsertBranding({ tenantId: TENANT_A, displayName: 'Acme Co' })
    expect(edited.checkoutSlug).toBe('acme') // unchanged
    expect(edited.merchantId).toBe('7') // preserved
    expect(edited.logoBlobId).toBe('blob123') // preserved
    expect(edited.nameHash).toBe(nameHashOf('Acme Co')) // recomputed
  })

  it('its OWN slug is available to it (editing other fields)', () => {
    upsertBranding({ tenantId: TENANT_A, displayName: 'Acme', checkoutSlug: 'acme' })
    expect(isSlugAvailable('acme', TENANT_A)).toBe(true)
    expect(isSlugAvailable('acme', TENANT_B)).toBe(false)
  })
})

describe('lookups', () => {
  it('getBySlug / getByMerchantId / getByTenant resolve the row', () => {
    upsertBranding({ tenantId: TENANT_A, displayName: 'Acme', checkoutSlug: 'acme' })
    attachOnChain(TENANT_A, { merchantId: '42' })
    expect(getBySlug('acme')?.tenantId).toBe(TENANT_A)
    expect(getByMerchantId('42')?.tenantId).toBe(TENANT_A)
    expect(getByTenant(TENANT_A)?.checkoutSlug).toBe('acme')
    expect(getBySlug('nope')).toBeNull()
    expect(getByMerchantId('999')).toBeNull()
  })

  it('slug lookup is case-insensitive on input', () => {
    upsertBranding({ tenantId: TENANT_A, displayName: 'Acme', checkoutSlug: 'acme' })
    expect(getBySlug('ACME')?.tenantId).toBe(TENANT_A)
  })
})

describe('suggestSlugs', () => {
  it('suggests free -n alternatives when the base is taken', () => {
    upsertBranding({ tenantId: TENANT_A, displayName: 'Acme', checkoutSlug: 'acme' })
    const s = suggestSlugs('Acme', TENANT_B, 3)
    expect(s.length).toBe(3)
    expect(s.every((x) => isValidSlug(x))).toBe(true)
    expect(s).toContain('acme-2')
  })
})

describe('attachOnChain', () => {
  it('returns null when the tenant has no branding yet', () => {
    expect(attachOnChain(TENANT_A, { merchantId: '1' })).toBeNull()
  })
})
