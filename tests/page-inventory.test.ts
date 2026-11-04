import { describe, expect, it } from "vitest";

import { buildPageInventory, pageTypeOf } from "@/lib/research/page-inventory";

/**
 * The synthesizer used to be shown the 30 highest-scoring pages. On one tenant that
 * was 30 development pages and zero city pages, so it reported the site had no
 * city-level entry point — while the crawl held 13 city pages.
 */
const property = (id: number, locale = "") => ({
  url: `https://www.casamigo.net${locale}/property/development-${id}`,
  contentScore: 100,
});
const city = (slug: string) => ({ url: `https://www.casamigo.net/cities/${slug}`, contentScore: 95 });

describe("page type inventory", () => {
  it("folds a locale prefix into the page type", () => {
    expect(pageTypeOf("https://www.casamigo.net/es/property/villa")).toBe("property");
    expect(pageTypeOf("https://www.casamigo.net/property/villa")).toBe("property");
    expect(pageTypeOf("https://www.casamigo.net/es")).toBe("home");
    expect(pageTypeOf("https://www.casamigo.net/")).toBe("home");
    expect(pageTypeOf("https://www.casamigo.net/cities/tulum")).toBe("cities");
  });

  it("shows a hub page even when detail pages outnumber it 20 to 1", () => {
    const pages = [...Array.from({ length: 20 }, (_, i) => property(i)), city("tulum"), city("cancun")];
    const inventory = buildPageInventory(pages, 30);
    expect(inventory.sampled.some((url) => url.includes("/cities/"))).toBe(true);
    expect(inventory.groups.find((group) => group.type === "cities")?.pages).toBe(2);
    expect(inventory.groups.find((group) => group.type === "property")?.pages).toBe(20);
  });

  it("gives every type one page before any type gets a second", () => {
    const pages = [
      ...Array.from({ length: 10 }, (_, i) => property(i)),
      city("tulum"),
      city("cancun"),
      { url: "https://www.casamigo.net/post/one", contentScore: 90 },
    ];
    const inventory = buildPageInventory(pages, 6);
    const types = inventory.sampled.map(pageTypeOf);
    expect(new Set(types.slice(0, 3)).size).toBe(3);
    expect(inventory.sampled).toHaveLength(6);
  });

  it("picks each type's strongest page as its representative", () => {
    const pages = [
      { url: "https://www.casamigo.net/cities/tulum", contentScore: 60 },
      { url: "https://www.casamigo.net/cities/cancun", contentScore: 95 },
    ];
    expect(buildPageInventory(pages, 1).sampled).toEqual(["https://www.casamigo.net/cities/cancun"]);
  });

  it("reports the full crawl size, not the sample size", () => {
    const pages = Array.from({ length: 50 }, (_, i) => property(i));
    const inventory = buildPageInventory(pages, 30);
    expect(inventory.total).toBe(50);
    expect(inventory.sampled).toHaveLength(30);
  });

  it("stops cleanly when the site has fewer pages than the limit", () => {
    const inventory = buildPageInventory([property(1), city("tulum")], 30);
    expect(inventory.sampled).toHaveLength(2);
  });
});
