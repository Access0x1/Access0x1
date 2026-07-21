/**
 * Server-side locale resolution for server components + route handlers.
 *
 * Priority: the `access0x1_lang` cookie (an explicit switcher choice) -> the
 * Accept-Language header -> DEFAULT_LOCALE. See resolveLocale() for the pure
 * decision; this module only wires it to next/headers.
 */
import { cookies, headers } from "next/headers";

import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type LocaleCode } from "./config";
import { resolveLocale } from "./pick-locale";

export async function getLocale(): Promise<LocaleCode> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieValue)) return cookieValue;

  const headerList = await headers();
  return resolveLocale(null, headerList.get("accept-language"));
}

export { DEFAULT_LOCALE };
export type { LocaleCode };
