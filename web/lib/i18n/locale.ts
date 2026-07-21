/**
 * Server-side locale resolution for server components + route handlers.
 *
 * Priority: the `access0x1_lang` cookie (explicit switcher choice) -> an explicit
 * browser language -> a geo hint (`CloudFront-Viewer-Country`, used only when no
 * language was stated) -> DEFAULT_LOCALE. See resolveLocale() for the pure decision;
 * this module only wires it to next/headers.
 *
 * getLocaleContext() also returns `offer`: the locale to surface via the client
 * switch-prompt (e.g. an English page for a visitor in Portugal), or null.
 */
import { cookies, headers } from "next/headers";

import { DEFAULT_LOCALE, LOCALE_COOKIE, type LocaleCode } from "./config";
import { localeOffer, resolveLocale } from "./pick-locale";

/** CloudFront sets this when it fronts the origin; absent on a bare Cloud Run hit. */
const COUNTRY_HEADER = "cloudfront-viewer-country";

export interface LocaleContext {
  locale: LocaleCode;
  /** Locale to offer via the switch-prompt, or null (already matching / chosen / no geo). */
  offer: LocaleCode | null;
}

export async function getLocaleContext(): Promise<LocaleContext> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(LOCALE_COOKIE)?.value ?? null;

  const headerList = await headers();
  const accept = headerList.get("accept-language");
  const country = headerList.get(COUNTRY_HEADER);

  const locale = resolveLocale(cookieValue, accept, country);
  return { locale, offer: localeOffer(locale, cookieValue, country) };
}

export async function getLocale(): Promise<LocaleCode> {
  return (await getLocaleContext()).locale;
}

export { DEFAULT_LOCALE };
export type { LocaleCode };
