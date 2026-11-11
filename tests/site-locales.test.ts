import { describe, expect, it } from "vitest";

import { localeQuery, localeVariants, parseSiteLocales } from "@/lib/site-locales";

describe("site locales", () => {
  it("reads a prefix locale list", () => {
    const locales = parseSiteLocales({
      default: "fr",
      variants: [
        { code: "fr", prefix: "", query: null },
        { code: "en", prefix: "/en", query: null },
      ],
    });
    expect(locales?.default).toBe("fr");
    expect(locales?.variants).toHaveLength(2);
  });

  it("reads a query locale list", () => {
    const locales = parseSiteLocales({
      default: "en",
      variants: [
        { code: "en", prefix: "", query: null },
        { code: "es", prefix: "", query: "lang=es" },
      ],
    });
    expect(locales?.variants[1]).toEqual({ code: "es", prefix: "", query: "lang=es" });
  });

  it("rejects a list with no usable variant", () => {
    expect(parseSiteLocales({ variants: [] })).toBeNull();
    expect(parseSiteLocales({ variants: [{ code: "english" }] })).toBeNull();
  });

  it("builds a route and URL per locale", () => {
    const locales = parseSiteLocales({
      default: "fr",
      variants: [
        { code: "fr", prefix: "", query: null },
        { code: "en", prefix: "/en", query: null },
      ],
    })!;
    const variants = localeVariants(locales, "/abat-jour-sur-mesure", "https://www.atelier-harmonie.com");
    expect(variants.map((variant) => variant.route)).toEqual(["/abat-jour-sur-mesure", "/en/abat-jour-sur-mesure"]);
    expect(variants[1].url).toBe("https://www.atelier-harmonie.com/en/abat-jour-sur-mesure");
    expect(variants[0].isDefault).toBe(true);
  });

  it("keeps one route and adds the query for a query locale", () => {
    const locales = parseSiteLocales({
      default: "en",
      variants: [
        { code: "en", prefix: "", query: null },
        { code: "es", prefix: "", query: "lang=es" },
      ],
    })!;
    const variants = localeVariants(locales, "/homes-for-sale-in-tulum", "https://www.susimacdonald.com");
    expect(variants.map((variant) => variant.route)).toEqual(["/homes-for-sale-in-tulum", "/homes-for-sale-in-tulum"]);
    expect(variants[1].url).toBe("https://www.susimacdonald.com/homes-for-sale-in-tulum?lang=es");
    expect(localeQuery(variants[1])).toEqual({ key: "lang", value: "es" });
    expect(localeQuery(variants[0])).toBeNull();
  });
});
