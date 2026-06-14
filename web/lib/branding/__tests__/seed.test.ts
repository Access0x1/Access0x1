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

import {
  featuredTenantId,
  readFeaturedMerchantInput,
  seedFeaturedMerchant,
  FEATURED_SLUG_ENV,
  FEATURED_NAME_ENV,
  FEATURED_DESCRIPTION_ENV,
  FEATURED_BRAND_COLOR_ENV,
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
})

describe('root page redirect target', () => {
  beforeEach(() => {
    redirect.mockClear()
    delete process.env.FEATURED_MERCHANT_SLUG
  })
  afterEach(() => {
    delete process.env.FEATURED_MERCHANT_SLUG
  })

  it('targets /onboard when no featured slug is set', async () => {
    const { default: Home } = await import('@/app/page')
    expect(() => Home()).toThrow('REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/onboard')
  })

  it('targets the branded checkout /c/<slug> when a featured slug is set', async () => {
    process.env.FEATURED_MERCHANT_SLUG = SLUG
    const { default: Home } = await import('@/app/page')
    expect(() => Home()).toThrow('REDIRECT')
    expect(redirect).toHaveBeenCalledWith(`/c/${SLUG}`)
  })
})

describe('Powered by Access0x1 footer is preserved', () => {
  it('the slug checkout view still renders the footer text', () => {
    const viewPath = fileURLToPath(
      new URL('../../../components/pages/SlugCheckoutView.tsx', import.meta.url),
    )
    const src = readFileSync(viewPath, 'utf8')
    expect(src).toContain('Powered by Access0x1')
  })
})
