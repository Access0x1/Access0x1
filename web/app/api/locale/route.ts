import { NextResponse } from 'next/server'

import { LOCALE_COOKIE, isLocale } from '@/lib/i18n/config'

/**
 * POST { locale } — set the `access0x1_lang` cookie SERVER-SIDE so the
 * marketing pages re-render in the chosen locale. The LanguageSwitcher calls
 * this then reloads. The cookie is a UI preference (path=/, 1y, SameSite=Lax);
 * an invalid locale is rejected so only a supported code can ever be stored.
 *
 * `Secure` is set in production only: behind the CDN everything is HTTPS, but a
 * Secure cookie is silently dropped over plain http://localhost, which would
 * break the switcher in local dev.
 *
 * NOTE: the cookie NAME is a deploy-time contract — the CDN must forward it AND
 * include it in the cache key (see docs/WEB-DEPLOY.md §8). Renaming it without
 * updating the edge config serves cached pages in the wrong language.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let locale: unknown = null
  try {
    locale = (await req.json())?.locale
  } catch {
    locale = null
  }
  if (!isLocale(locale)) {
    return NextResponse.json({ error: 'invalid_locale' }, { status: 400 })
  }
  const res = NextResponse.json({ ok: true, locale })
  res.cookies.set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
  return res
}
