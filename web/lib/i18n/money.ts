/**
 * Locale-aware money formatting — ASSET-STABLE (money-safety invariant).
 *
 * The pricing unit stays USD and the settlement asset stays USDC in EVERY
 * locale. Localization ONLY formats the NUMBER (grouping, decimal mark, symbol
 * placement) via Intl.NumberFormat — it never changes the asset or the charged
 * amount. e.g. `formatUsd(12, "pt")` -> "US$ 12,00", still USD, still charged in
 * USDC.
 *
 * Any local-currency figure shown elsewhere (e.g. an indicative "≈ €11,10" from
 * a Chainlink feed) MUST be labelled indicative and MUST NOT come from here —
 * this helper only ever emits USD.
 */
import { bcp47ForLocale } from "./og-locale";

export function formatUsd(amount: number, locale: string | null | undefined): string {
  try {
    return new Intl.NumberFormat(bcp47ForLocale(locale), {
      style: "currency",
      currency: "USD",
    }).format(amount);
  } catch {
    // Never throw on a money render — fall back to a plain USD string.
    return `US$ ${amount.toFixed(2)}`;
  }
}
