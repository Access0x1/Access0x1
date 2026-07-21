import { describe, expect, it } from "vitest";

import {
  localeOffer,
  pickFromAcceptLanguage,
  pickFromCountry,
  resolveLocale,
} from "../pick-locale";
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

describe("pickFromCountry (geo -> locale; PT-speaking, not Brazil)", () => {
  it("maps Portuguese-speaking countries to pt (case-insensitive)", () => {
    expect(pickFromCountry("PT")).toBe("pt");
    expect(pickFromCountry("pt")).toBe("pt");
    expect(pickFromCountry("AO")).toBe("pt"); // Angola
  });
  it("returns null for Brazil (distinct pt-BR) and non-lusophone / absent", () => {
    expect(pickFromCountry("BR")).toBeNull();
    expect(pickFromCountry("US")).toBeNull();
    expect(pickFromCountry(null)).toBeNull();
    expect(pickFromCountry("")).toBeNull();
  });
});

describe("resolveLocale with geo (geo fills a gap, never overrides a stated language)", () => {
  it("uses geo only when NO supported language was stated", () => {
    expect(resolveLocale(null, null, "PT")).toBe("pt");
    expect(resolveLocale(null, "de,ja;q=0.8", "PT")).toBe("pt");
  });
  it("keeps an explicit English even from Portugal (the ask-prompt handles it)", () => {
    expect(resolveLocale(null, "en-US,en;q=0.9", "PT")).toBe("en");
  });
  it("lets an explicit pt browser win regardless of geo", () => {
    expect(resolveLocale(null, "pt-PT", "US")).toBe("pt");
  });
  it("still lets the cookie win over geo", () => {
    expect(resolveLocale("en", null, "PT")).toBe("en");
  });
});

describe("localeOffer (the 'in Portugal but seeing English' ask)", () => {
  it("offers pt when geo=PT, the page is English, and no explicit choice", () => {
    expect(localeOffer("en", null, "PT")).toBe("pt");
  });
  it("does NOT offer when already showing the geo locale", () => {
    expect(localeOffer("pt", null, "PT")).toBeNull();
  });
  it("does NOT offer once the visitor has chosen (cookie set)", () => {
    expect(localeOffer("en", "en", "PT")).toBeNull();
  });
  it("does NOT offer without a geo signal", () => {
    expect(localeOffer("en", null, "US")).toBeNull();
    expect(localeOffer("en", null, null)).toBeNull();
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
