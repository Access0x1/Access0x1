/**
 * Dictionary loader. Static imports so the bundler tree-shakes + the marketing
 * pages stay server-rendered with no client fetch. Any locale without a
 * dictionary falls back to English (never a blank string).
 */
import { DEFAULT_LOCALE, type LocaleCode } from "./config";
import en from "./dictionaries/en.json";
import pt from "./dictionaries/pt.json";

/** The dictionary shape — English is the canonical key set (parity-tested). */
export type Dictionary = typeof en;

const DICTIONARIES: Record<LocaleCode, Dictionary> = {
  en,
  pt: pt as Dictionary,
};

export function getDictionary(locale: LocaleCode): Dictionary {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}
