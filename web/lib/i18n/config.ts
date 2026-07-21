/**
 * i18n config — the single source of truth for the interface's locale set.
 *
 * Pattern: cookie + Accept-Language negotiation, per-locale JSON dictionaries,
 * and locale-aware metadata. No geo-IP layer (Cloud Run has no edge country
 * header) — pure Accept-Language plus an explicit switcher choice persisted in
 * a cookie.
 *
 * ADDING A LOCALE is dictionary + config only, ZERO component edits: drop a
 * `dictionaries/<code>.json` (same key shape as en.json) and add the code here.
 * The dictionary-parity test enforces the shape; the copy-law test enforces the
 * banned-term rule in every locale.
 *
 * pt = European Portuguese (pt-PT), NOT Brazilian — the Lisbon launch audience.
 * The BCP-47 tag is resolved in `og-locale.ts` (pt -> pt-PT / pt_PT).
 */

export const LOCALES = ["en", "pt"] as const;
export type LocaleCode = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: LocaleCode = "en";

/** The cookie the switcher + /api/locale write; read server-side by getLocale(). */
export const LOCALE_COOKIE = "access0x1_lang";

export function isLocale(value: unknown): value is LocaleCode {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Per-locale rendering metadata. `dir` drives the <html dir> attribute (RTL-ready). */
export const LOCALE_META: Readonly<Record<LocaleCode, { dir: "ltr" | "rtl"; label: string }>> = {
  en: { dir: "ltr", label: "English" },
  pt: { dir: "ltr", label: "Português" },
};

export function localeMeta(locale: LocaleCode): { dir: "ltr" | "rtl"; label: string } {
  return LOCALE_META[locale];
}
