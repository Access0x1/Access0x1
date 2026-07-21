/**
 * BCP-47 tag + Open Graph locale for a dictionary code. Kept in ONE place so the
 * <html lang>, Intl formatters, and og:locale never disagree.
 *
 * pt -> pt-PT (European Portuguese: 24h, "12,50 US$", Monday-first) — NOT pt-BR.
 */
import { LOCALES, type LocaleCode } from "./config";

const BCP47_BY_LOCALE: Record<LocaleCode, string> = {
  en: "en-US",
  pt: "pt-PT",
};

/** Region-qualified BCP-47 tag for Intl.* and <html lang>. */
export function bcp47ForLocale(locale: string | null | undefined): string {
  if (!locale) return "en-US";
  return BCP47_BY_LOCALE[locale as LocaleCode] ?? "en-US";
}

/**
 * Open Graph `og:locale` (`language_TERRITORY`, underscore) derived from the
 * same BCP-47 map, so a page's social-card language always agrees with its
 * <html lang> and Intl formatting (pt -> pt_PT, en -> en_US).
 */
export function ogLocaleForLocale(locale: string | null | undefined): string {
  const tag = bcp47ForLocale(locale);
  return tag.includes("-") ? tag.replace("-", "_") : `${tag}_${tag.toUpperCase()}`;
}

/** All og:locale values EXCEPT the active one — for og:locale:alternate. */
export function ogLocaleAlternates(active: string | null | undefined): string[] {
  return (LOCALES as readonly string[])
    .filter((l) => l !== active)
    .map((l) => ogLocaleForLocale(l));
}
