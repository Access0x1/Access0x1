/**
 * Pure Accept-Language -> LocaleCode negotiation. No next/headers import so it
 * stays usable from any runtime (edge, node, tests).
 */
import { DEFAULT_LOCALE, LOCALES, type LocaleCode } from "./config";

// RFC 7231 caps Accept-Language well under this; real browsers send ~120 bytes.
// A hard cap prevents a hostile 10MB header from making parse cost O(n log n)
// on every request.
const MAX_ACCEPT_LANGUAGE_BYTES = 1024;

/**
 * Best supported locale for an Accept-Language header, honouring q-values
 * ("es;q=0.4, pt;q=0.9" -> pt). Returns null when nothing matches — the caller
 * applies DEFAULT_LOCALE, so a bare/absent header never forces a wrong pick.
 */
export function pickFromAcceptLanguage(
  accept: string | null | undefined,
): LocaleCode | null {
  if (!accept) return null;
  if (accept.length > MAX_ACCEPT_LANGUAGE_BYTES) return null;

  const ranked = accept
    .split(",")
    .map((entry) => {
      const [rawTag, ...params] = entry.trim().split(";");
      const tag = rawTag?.toLowerCase() ?? "";
      let q = 1;
      for (const p of params) {
        const m = p.trim().match(/^q=([0-9.]+)$/i);
        if (m) {
          const parsed = Number.parseFloat(m[1]!);
          if (!Number.isNaN(parsed)) q = Math.max(0, Math.min(1, parsed));
        }
      }
      return { tag, q };
    })
    .filter((e) => e.tag && e.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const primary = tag.split("-")[0];
    if (primary && (LOCALES as readonly string[]).includes(primary)) {
      return primary as LocaleCode;
    }
  }
  return null;
}

// Countries where European Portuguese (pt-PT) is the right default: the lusophone
// world EXCEPT Brazil, which uses a distinct pt-BR we do not ship. ISO 3166-1 alpha-2.
const PT_COUNTRIES = new Set(["PT", "AO", "MZ", "CV", "GW", "ST", "TL"]);

/**
 * Map an edge country code (e.g. `CloudFront-Viewer-Country: PT`) to a supported
 * locale, or null. Geo is a WEAK signal by design — resolveLocale only lets it
 * fill a gap when the visitor stated no language; it never overrides Accept-Language.
 */
export function pickFromCountry(
  country: string | null | undefined,
): LocaleCode | null {
  if (!country) return null;
  return PT_COUNTRIES.has(country.trim().toUpperCase()) ? "pt" : null;
}

/**
 * Combine an explicit cookie choice, the Accept-Language signal, and an optional
 * edge country hint into ONE locale. Precedence:
 *   1. a valid cookie (explicit switcher choice) — always wins;
 *   2. an explicit NON-default browser language (a `pt` browser gets pt);
 *   3. geo, ONLY when the browser stated no supported language (in Portugal with
 *      no preference -> Portuguese) — explicit English is a real choice, so it is
 *      kept and the ask-prompt (see localeOffer) handles that case instead;
 *   4. DEFAULT_LOCALE.
 * Kept pure so getLocale() and any middleware share one decision. `country` is
 * optional, so existing two-arg callers are unaffected.
 */
export function resolveLocale(
  cookieValue: string | null | undefined,
  accept: string | null | undefined,
  country?: string | null | undefined,
): LocaleCode {
  if (cookieValue && (LOCALES as readonly string[]).includes(cookieValue)) {
    return cookieValue as LocaleCode;
  }
  const fromLang = pickFromAcceptLanguage(accept);
  if (fromLang && fromLang !== DEFAULT_LOCALE) return fromLang;
  if (fromLang === null) {
    const fromGeo = pickFromCountry(country);
    if (fromGeo) return fromGeo;
  }
  return fromLang ?? DEFAULT_LOCALE;
}

/**
 * Which locale to OFFER via the client switch-prompt, or null. Fires only for the
 * "you're in Portugal but the page is English" case: geo names a locale the visitor
 * is NOT seeing AND they made no explicit choice (no cookie). We render their
 * explicit English and ASK — never force. Null on every other path (already
 * matching / explicit choice / no geo) so the prompt never nags.
 */
export function localeOffer(
  resolved: LocaleCode,
  cookieValue: string | null | undefined,
  country: string | null | undefined,
): LocaleCode | null {
  if (cookieValue && (LOCALES as readonly string[]).includes(cookieValue)) {
    return null;
  }
  const fromGeo = pickFromCountry(country);
  return fromGeo && fromGeo !== resolved ? fromGeo : null;
}
