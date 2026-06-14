import { redirect } from 'next/navigation'

/**
 * Root entry point.
 *
 * By default this redirects to the onboarding flow — the product entry point a
 * fresh deployment shows. BUT a hosted instance can feature ONE business as its
 * stable default brand: when `FEATURED_MERCHANT_SLUG` is set (the same env that
 * seeds the branding row — see lib/branding/seed.ts), the root sends visitors
 * straight to that business's branded checkout (`/c/<slug>`), which is the public
 * surface the deployment wants to showcase. `/onboard` stays reachable directly.
 */
export default function Home(): never {
  const featuredSlug = (process.env.FEATURED_MERCHANT_SLUG ?? '').trim()
  if (featuredSlug) {
    redirect(`/c/${encodeURIComponent(featuredSlug)}`)
  }
  redirect('/onboard')
}
