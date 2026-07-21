import { describe, expect, it } from "vitest";

import { pickFromAcceptLanguage, resolveLocale } from "../pick-locale";
import { bcp47ForLocale, ogLocaleForLocale, ogLocaleAlternates } from "../og-locale";

describe("pickFromAcceptLanguage", () => {
  it("negotiates the best supported locale by q-value", () => {
    expect(pickFromAcceptLanguage("pt-PT,pt;q=0.9,en;q=0.5")).toBe("pt");
    expect(pickFromAcceptLanguage("es;q=0.4, pt;q=0.9")).toBe("pt");
    expect(pickFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
  });

  it("returns null when nothing supported / header absent (caller applies default)", () => {
    expect(pickFromAcceptLanguage("de,ja;q=0.8")).toBeNull();
    expect(pickFromAcceptLanguage(null)).toBeNull();
    expect(pickFromAcceptLanguage("")).toBeNull();
  });

  it("ignores an oversized (hostile) header", () => {
    expect(pickFromAcceptLanguage("pt,".repeat(2000))).toBeNull();
  });
});

describe("resolveLocale (cookie wins, else negotiate, else default)", () => {
  it("an explicit cookie choice always wins", () => {
    expect(resolveLocale("pt", "en-US,en;q=0.9")).toBe("pt");
    expect(resolveLocale("en", "pt-PT")).toBe("en");
  });
  it("falls back to Accept-Language, then to the default", () => {
    expect(resolveLocale(null, "pt-PT,pt;q=0.9")).toBe("pt");
    expect(resolveLocale(undefined, "de")).toBe("en");
    expect(resolveLocale("garbage", null)).toBe("en");
  });
});

describe("BCP-47 + og:locale (pt = European Portuguese)", () => {
  it("maps pt -> pt-PT / pt_PT (never pt-BR)", () => {
    expect(bcp47ForLocale("pt")).toBe("pt-PT");
    expect(ogLocaleForLocale("pt")).toBe("pt_PT");
  });
  it("maps en -> en-US / en_US and falls back for unknown", () => {
    expect(ogLocaleForLocale("en")).toBe("en_US");
    expect(bcp47ForLocale("zz")).toBe("en-US");
  });
  it("alternates exclude the active locale", () => {
    expect(ogLocaleAlternates("pt")).toEqual(["en_US"]);
    expect(ogLocaleAlternates("en")).toEqual(["pt_PT"]);
  });
});
