import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { BrandMark } from '@/components/BrandMark'
import { CalcadaDivider } from '@/components/marketing/Calcada'
import { Hero } from '@/components/marketing/Hero'
import { FeatureGrid } from '@/components/marketing/FeatureGrid'
import { IntegrationStrip } from '@/components/marketing/IntegrationStrip'
import { LandingCTA } from '@/components/marketing/LandingCTA'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { LocalePrompt } from '@/components/LocalePrompt'
import { getLocale, getLocaleContext } from '@/lib/i18n/locale'
import { getDictionary } from '@/lib/i18n/get-dictionary'

/**
 * Root entry point ("/") — the public marketing landing, now localized.
 *
 * The landing IS the public face, so it renders here (it used to redirect to
 * /onboard). A hosted instance can still feature ONE business as its default
 * brand: when `FEATURED_MERCHANT_SLUG` is set, the root sends visitors straight
 * to that business's branded checkout (`/c/<slug>`). `/onboard` stays reachable.
 *
 * Copy comes from the active locale dictionary (getLocale -> getDictionary),
 * threaded server-side into the marketing components so the whole page renders
 * translated for SEO — no client-side flash.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDictionary(await getLocale())
  return {
    title: dict.meta.homeTitle,
    description: dict.meta.homeDescription,
  }
}

export default async function Home(): Promise<ReactNode> {
  const featuredSlug = (process.env.FEATURED_MERCHANT_SLUG ?? '').trim()
  if (featuredSlug) {
    redirect(`/c/${encodeURIComponent(featuredSlug)}`)
  }

  const { locale, offer } = await getLocaleContext()
  const dict = getDictionary(locale)

  return (
    <main className="flex min-h-screen flex-col">
      {/* Top fold: the one-liner + primary CTA. */}
      <Hero hero={dict.hero} cta={dict.cta} />

      {/* Trust strip: Chainlink + the settlement chains. */}
      <IntegrationStrip integrations={dict.integrations} />

      {/* Calçada ribbon — the Lisbon mosaic border between the strip and grid. */}
      <CalcadaDivider className="py-2" />

      {/* The capability grid across the contract surface. */}
      <FeatureGrid features={dict.features} />

      {/* Closing call-to-action — a second, explicit path into onboarding. */}
      <section className="mx-auto w-full max-w-3xl px-6 pb-28 pt-8 text-center">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {dict.landing.closingHeading}
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-balance text-muted-foreground">
          {dict.landing.closingBody}
        </p>
        <LandingCTA cta={dict.cta} className="mt-8" />
      </section>

      {/* Minimal footer: the brand lockup + localized links + language switcher. */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
          <BrandMark size={20} />
          <p className="text-xs text-muted-foreground">
            <Link href="/vision" className="text-primary hover:underline">
              {dict.landing.footer.vision}
            </Link>{' '}
            ·{' '}
            <Link href="/journey" className="text-primary hover:underline">
              {dict.landing.footer.journey}
            </Link>{' '}
            ·{' '}
            <Link href="/simulate" className="text-primary hover:underline">
              {dict.landing.footer.simulator}
            </Link>{' '}
            ·{' '}
            <Link href="/contracts" className="text-primary hover:underline">
              {dict.landing.footer.contracts}
            </Link>{' '}
            · {dict.landing.footer.tagline}
          </p>
          <LanguageSwitcher active={locale} label={dict.switcher.label} />
        </div>
      </footer>

      {/* Resilient geo ask-prompt: offers Português, once, to a visitor in
          Portugal who is seeing English. Renders nothing when there's no offer. */}
      <LocalePrompt offer={offer} />
    </main>
  )
}
