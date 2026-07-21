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

/**
 * Combine an explicit cookie choice with the Accept-Language signal. The cookie
 * (an explicit switcher choice) always wins; otherwise negotiate the header;
 * otherwise DEFAULT_LOCALE. Kept pure so both getLocale() and any middleware
 * share ONE decision.
 */
export function resolveLocale(
  cookieValue: string | null | undefined,
  accept: string | null | undefined,
): LocaleCode {
  if (cookieValue && (LOCALES as readonly string[]).includes(cookieValue)) {
    return cookieValue as LocaleCode;
  }
  return pickFromAcceptLanguage(accept) ?? DEFAULT_LOCALE;
}
