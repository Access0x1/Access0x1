/**
 * seed.test.ts — the optional, env-driven FEATURED MERCHANT seed (one stable
 * default brand for a hosted instance).
 *
 * Contract pinned here:
 *   - With FEATURED_MERCHANT_SLUG + FEATURED_MERCHANT_NAME set, the store gains
 *     ONE row reachable by `getBySlug(slug)` with the right display name, an
 *     auto-monogram logo (no asset file), the description + brand color when
 *     given, and a stable derived tenant id — idempotent on repeat.
 *   - With the env UNSET (or only one of the pair set), NOTHING is seeded.
 *   - The root page still targets `/onboard` when the slug is unset, and targets
 *     `/c/<slug>` when it is set (the branded public checkout).
 *   - The "Powered by Access0x1" footer the slug checkout renders is unchanged.
 *
 * The seed reads `process.env` but we pass an explicit env map to the pure
 * helpers so these run deterministically offline.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the `next/navigation` mock factory (itself hoisted above imports)
// can reference it. `redirect` throws to mimic Next's never-returning contract.
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((_url: string) => {
    throw new Error('REDIRECT')
  }),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirect(url),
}))

// Home() now resolves the locale (next/headers) on the no-redirect path; stub
// it to the default-locale signals (no cookie, no Accept-Language) so the
// landing renders without a live request context.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}))

import {
  featuredTenantId,
  readFeaturedMerchantInput,
  seedFeaturedMerchant,
  FEATURED_SLUG_ENV,
  FEATURED_NAME_ENV,
  FEATURED_DESCRIPTION_ENV,
  FEATURED_BRAND_COLOR_ENV,
  FEATURED_MERCHANT_ID_ENV,
  FEATURED_MERCHANT_CHAIN_ID_ENV,
  FEATURED_CHECKOUT_MODE_ENV,
} from '../seed.js'
import {
  __resetBrandingStore,
  getBySlug,
  upsertBranding,
} from '../store.js'
import { DEFAULT_BRAND_COLOR } from '../logo.js'

const SLUG = 'acme-coffee'
const NAME = 'Acme Coffee'

beforeEach(() => {
  __resetBrandingStore()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('readFeaturedMerchantInput — env gating (pure)', () => {
  it('returns null when neither slug nor name is set', () => {
    expect(readFeaturedMerchantInput({})).toBeNull()
  })
  it('returns null when only the slug is set', () => {
    expect(readFeaturedMerchantInput({ [FEATURED_SLUG_ENV]: SLUG })).toBeNull()
  })
  it('returns null when only the name is set', () => {
    expect(readFeaturedMerchantInput({ [FEATURED_NAME_ENV]: NAME })).toBeNull()
  })
  it('treats blank/whitespace-only values as unset', () => {
    expect(
      readFeaturedMerchantInput({ [FEATURED_SLUG_ENV]: '   ', [FEATURED_NAME_ENV]: '  ' }),
    ).toBeNull()
  })
  it('builds an input with a stable tenant id, slug, name + monogram logo', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
    })
    expect(input).not.toBeNull()
    expect(input!.tenantId).toBe(`featured:${SLUG}`)
    expect(input!.checkoutSlug).toBe(SLUG)
    expect(input!.displayName).toBe(NAME)
    // Auto-monogram from the name — initials "AC", no asset file needed.
    expect(input!.logoSvgInline).toContain('<svg')
    expect(input!.logoSvgInline).toContain('AC')
    // Default brand color when none supplied.
    expect(input!.brandColor).toBe(DEFAULT_BRAND_COLOR)
  })
  it('carries the optional description + brand color when supplied', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_DESCRIPTION_ENV]: 'Single-origin coffee, roasted daily.',
      [FEATURED_BRAND_COLOR_ENV]: '#0A7E5C',
    })
    expect(input!.description).toBe('Single-origin coffee, roasted daily.')
    expect(input!.brandColor).toBe('#0A7E5C')
  })

  it('sets merchantId when FEATURED_MERCHANT_MERCHANT_ID is a positive integer', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_MERCHANT_ID_ENV]: '1',
    })
    expect(input!.merchantId).toBe('1')
  })

  it('leaves merchantId null when FEATURED_MERCHANT_MERCHANT_ID is absent', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
    })
    expect(input!.merchantId).toBeNull()
  })

  it('leaves merchantId null when FEATURED_MERCHANT_MERCHANT_ID is zero', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_MERCHANT_ID_ENV]: '0',
    })
    expect(input!.merchantId).toBeNull()
  })

  it('leaves merchantId null when FEATURED_MERCHANT_MERCHANT_ID is non-numeric', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_MERCHANT_ID_ENV]: 'abc',
    })
    expect(input!.merchantId).toBeNull()
  })

  it('leaves merchantId null when FEATURED_MERCHANT_MERCHANT_ID is negative', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_MERCHANT_ID_ENV]: '-5',
    })
    expect(input!.merchantId).toBeNull()
  })

  it('sets merchantChainId when FEATURED_MERCHANT_CHAIN_ID is a settlement chain', () => {
    // 84532 (Base Sepolia) is a supported, mirror-routed settlement chain — so a
    // featured merchant on it settles on 84532, not the app default (wave-4 parity).
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_MERCHANT_ID_ENV]: '1',
      [FEATURED_MERCHANT_CHAIN_ID_ENV]: '84532',
    })
    expect(input!.merchantChainId).toBe(84532)
  })

  it('leaves merchantChainId null when FEATURED_MERCHANT_CHAIN_ID is absent (default fallback)', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_MERCHANT_ID_ENV]: '1',
    })
    expect(input!.merchantChainId).toBeNull()
  })

  it('leaves merchantChainId null when FEATURED_MERCHANT_CHAIN_ID is not a settlement chain', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_MERCHANT_CHAIN_ID_ENV]: '999999', // unsupported ⇒ never pinned to a bad chain
    })
    expect(input!.merchantChainId).toBeNull()
  })

  it('sets checkoutMode from FEATURED_MERCHANT_CHECKOUT_MODE when valid', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_CHECKOUT_MODE_ENV]: 'verified-human',
    })
    expect(input!.checkoutMode).toBe('verified-human')
  })

  it('defaults checkoutMode to standard when FEATURED_MERCHANT_CHECKOUT_MODE is absent', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
    })
    expect(input!.checkoutMode).toBe('standard')
  })

  it('defaults checkoutMode to standard when FEATURED_MERCHANT_CHECKOUT_MODE is unrecognised', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_CHECKOUT_MODE_ENV]: 'bogus-value',
    })
    expect(input!.checkoutMode).toBe('standard')
  })

  it('honours private checkoutMode', () => {
    const input = readFeaturedMerchantInput({
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_CHECKOUT_MODE_ENV]: 'private',
    })
    expect(input!.checkoutMode).toBe('private')
  })
})

describe('seedFeaturedMerchant — store seeding', () => {
  it('seeds ONE row reachable by getBySlug with the right name + monogram', () => {
    const row = seedFeaturedMerchant(upsertBranding, {
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
    })
    expect(row).not.toBeNull()

    const got = getBySlug(SLUG)
    expect(got).not.toBeNull()
    expect(got!.displayName).toBe(NAME)
    expect(got!.tenantId).toBe(`featured:${SLUG}`)
    expect(got!.logoSvgInline).toContain('<svg')
    expect(got!.logoSvgInline).toContain('AC')
    // Not on-chain yet — branding-only, no payout address in the row's public view.
    expect(got!.merchantId).toBeNull()
  })

  it('does NOTHING when the env is unset (open-source default = empty store)', () => {
    const row = seedFeaturedMerchant(upsertBranding, {})
    expect(row).toBeNull()
    expect(getBySlug(SLUG)).toBeNull()
  })

  it('is idempotent — repeat calls keep ONE row under the same tenant id', () => {
    const env = { [FEATURED_SLUG_ENV]: SLUG, [FEATURED_NAME_ENV]: NAME }
    const first = seedFeaturedMerchant(upsertBranding, env)
    const second = seedFeaturedMerchant(upsertBranding, env)
    expect(first!.tenantId).toBe(second!.tenantId)
    expect(getBySlug(SLUG)!.tenantId).toBe(featuredTenantId(SLUG))
  })

  it('fails soft (returns null, no throw) on a malformed env value', () => {
    // An empty name after trim makes upsert reject; the seed swallows it.
    const row = seedFeaturedMerchant(upsertBranding, {
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: '<>',
    })
    expect(row).toBeNull()
    expect(getBySlug(SLUG)).toBeNull()
  })

  it('seeds merchantId when FEATURED_MERCHANT_MERCHANT_ID is set', () => {
    const row = seedFeaturedMerchant(upsertBranding, {
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_MERCHANT_ID_ENV]: '1',
    })
    expect(row).not.toBeNull()
    expect(row!.merchantId).toBe('1')
    // The slug→tenant lookup also works.
    expect(getBySlug(SLUG)!.merchantId).toBe('1')
  })

  it('seeds checkoutMode from env when valid', () => {
    const row = seedFeaturedMerchant(upsertBranding, {
      [FEATURED_SLUG_ENV]: SLUG,
      [FEATURED_NAME_ENV]: NAME,
      [FEATURED_CHECKOUT_MODE_ENV]: 'private',
    })
    expect(row!.checkoutMode).toBe('private')
  })
})

describe('root page redirect target', () => {
  beforeEach(() => {
    redirect.mockClear()
    delete process.env.FEATURED_MERCHANT_SLUG
  })
  afterEach(() => {
    delete process.env.FEATURED_MERCHANT_SLUG
  })

  it('renders the marketing landing (no redirect) when no featured slug is set', async () => {
    const { default: Home } = await import('@/app/page')
    // The root IS the public marketing landing by default now — it only
    // redirects when FEATURED_MERCHANT_SLUG is set (asserted below).
    const out = await Home()
    expect(out).toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('targets the branded checkout /c/<slug> when a featured slug is set', async () => {
    process.env.FEATURED_MERCHANT_SLUG = SLUG
    const { default: Home } = await import('@/app/page')
    // Home is async now, so the redirect() throw surfaces as a rejected promise.
    await expect(Home()).rejects.toThrow('REDIRECT')
    expect(redirect).toHaveBeenCalledWith(`/c/${SLUG}`)
  })
})

describe('Powered by Access0x1 footer is preserved', () => {
  it('the slug checkout view still renders the Powered-by attribution + brand mark', () => {
    const viewPath = fileURLToPath(
      new URL('../../../components/pages/SlugCheckoutView.tsx', import.meta.url),
    )
    const src = readFileSync(viewPath, 'utf8')
    // The attribution is now the "Powered by" line paired with the real
    // Access0x1 access-plug mark + wordmark (BrandMark renders "Access0x1"),
    // instead of a bare text string — but the credit is still there, by design.
    expect(src).toContain('Powered by')
    expect(src).toContain('<BrandMark')
  })
})
