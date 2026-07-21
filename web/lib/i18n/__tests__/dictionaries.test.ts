import { describe, expect, it } from "vitest";

import { LOCALES } from "../config";
import en from "../dictionaries/en.json";
import pt from "../dictionaries/pt.json";

const DICTS: Record<string, unknown> = { en, pt };

/** Flatten a nested dict to [dotpath, value] pairs (string leaves only). */
function flatten(obj: unknown, path = ""): Array<[string, string]> {
  if (typeof obj === "string") return [[path, obj]];
  if (obj && typeof obj === "object") {
    return Object.entries(obj).flatMap(([k, v]) =>
      flatten(v, path ? `${path}.${k}` : k),
    );
  }
  return [];
}

const keyPaths = (obj: unknown): string[] => flatten(obj).map(([k]) => k).sort();

/**
 * COPY LAW (money-safety + brand doctrine): marketing copy never says
 * "crypto / NFT / invest" — it says "AI agents", "your business", "on-chain
 * payments". The rule holds in EVERY language, so the list carries the pt/es/
 * fr/de equivalents too. A translation that reintroduces a banned term is a
 * FAILING translation.
 */
const BANNED: RegExp[] = [
  /\bcrypto\b/i,
  /\bnft\b/i,
  /\binvest(?:ing|ment|ments|or|ors)?\b/i,
  /\bcripto/i, // pt/es: cripto, criptomoeda
  /\binvestir\b/i,
  /\binvestiment/i, // pt
  /\binvertir\b/i, // es
  /\binvestieren\b/i,
  /\bkrypto/i, // de
];

export function bannedHits(text: string): string[] {
  return BANNED.filter((re) => re.test(text)).map((re) => re.source);
}

describe("i18n dictionary parity", () => {
  it("every LOCALES entry has a dictionary loaded here", () => {
    for (const l of LOCALES) expect(Object.keys(DICTS)).toContain(l);
  });

  it("pt has the exact same key set as en (adding a locale is dictionary-only)", () => {
    expect(keyPaths(pt)).toEqual(keyPaths(en));
  });

  it("no dictionary has an empty string value", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const [path, value] of flatten(dict)) {
        expect(value.trim().length, `${locale}.${path}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("copy-law gate", () => {
  it("no dictionary contains a banned term (crypto/NFT/invest, any language)", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const [path, value] of flatten(dict)) {
        expect(bannedHits(value), `${locale}.${path} = "${value}"`).toEqual([]);
      }
    }
  });

  it("CATCHES a seeded violation, then passes clean (fails-then-passes proof)", () => {
    expect(bannedHits("Invista em cripto hoje")).not.toEqual([]); // pt: invest + cripto
    expect(bannedHits("Buy an NFT with crypto")).not.toEqual([]); // en
    expect(bannedHits("Krypto investieren")).not.toEqual([]); // de
    // Clean, copy-law-compliant copy passes.
    expect(bannedHits("Aceite pagamentos on-chain em USDC com um agente de IA")).toEqual([]);
    expect(bannedHits("Accept on-chain payments in USDC with an AI agent")).toEqual([]);
  });
});
