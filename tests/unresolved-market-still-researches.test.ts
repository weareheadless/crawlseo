import { describe, expect, it } from "vitest";

import { resolveBundleLocale, type BundleLocale } from "@/lib/research/monthly-bundle";

/**
 * A site with no market still gets researched.
 *
 * ## The defect
 *
 * `resolveBundleLocale` threw when it could not name a market, and the throw happened
 * before `buildBundlePlan`. Every paid call is scoped to a DataForSEO location — but keyword
 * *discovery* and the model's seed proposal need only a language and the business's own
 * services. So refusing the bundle because the market was unknown also discarded the
 * discovery, and the site ended up with a map built from Search Console alone.
 *
 * Measured 2026-11-25 on alaguillotine: its map said "built without paid evidence", and the
 * one section that could have found demand never ran.
 *
 * ## The rule
 *
 * The market being unresolved is a fact about the site, not an error in the run. It resolves
 * to a locale with `marketSource: "unresolved"` and a reason an owner can act on; each priced
 * section refuses individually with the same reason; discovery and the seed proposal proceed.
 */

const context = (over: Partial<{ language: string; audienceCountry: string | null }> = {}) =>
  ({
    language: "en",
    audienceCountry: null,
    audienceCountries: [],
    ...over,
  }) as never;

const noImpressions = { keyword: { findMany: async () => [] } } as never;

describe("a market that cannot be named degrades, it does not refuse the bundle", () => {
  it("resolves to an unresolved locale instead of throwing", async () => {
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: noImpressions,
      siteId: "site-1",
      projectId: "project-1",
      context: context(),
      deps: {} as never,
    });
    expect(locale.marketSource).toBe("unresolved");
    expect(locale.country).toBeNull();
    expect(locale.locationCode).toBeNull();
  });

  it("keeps the language, because discovery does not need a market", async () => {
    // This is the whole point: the work that needs no location must still be described
    // well enough to run.
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: noImpressions,
      siteId: "site-1",
      projectId: "project-1",
      context: context({ language: "es" }),
      deps: {} as never,
    });
    expect(locale.language).toBe("es");
    expect(locale.languageCode).toBe("es");
  });

  it("says which kind of unknown it is, because the fixes differ", async () => {
    // "Nothing was ever measured" is fixed by connecting Search Console. "Measured and
    // scattered" is fixed by stating a market. Telling an owner the wrong one sends them to
    // the wrong screen.
    const never = await resolveBundleLocale({
      mode: "dry-run",
      db: noImpressions,
      siteId: "site-1",
      projectId: "project-1",
      context: context(),
      deps: {} as never,
    });
    expect(never.unresolved).toMatch(/no Search Console history/);

    const scattered = {
      keyword: {
        findMany: async () => [
          { country: "usa", impressions: 48 },
          { country: "fra", impressions: 16 },
          ...Array.from({ length: 29 }, (_, i) => ({ country: `c${i}`, impressions: 2 })),
        ],
      },
    } as never;
    const spread = await resolveBundleLocale({
      mode: "dry-run",
      db: scattered,
      siteId: "site-1",
      projectId: "project-1",
      context: context(),
      deps: {} as never,
    });
    expect(spread.unresolved).toMatch(/scattered/);
    expect(spread.unresolved).not.toMatch(/no Search Console history/);
  });

  it("still names a market when the audience measurably supplies one", async () => {
    // The refusal must not have become the default: a healthy site keeps its market.
    const clear = {
      keyword: {
        findMany: async () => [
          { country: "usa", impressions: 700 },
          { country: "mex", impressions: 200 },
          { country: "can", impressions: 100 },
        ],
      },
    } as never;
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: clear,
      siteId: "site-1",
      projectId: "project-1",
      context: context(),
      deps: {} as never,
    });
    expect(locale.marketSource).toBe("measured");
    expect(locale.country).toBe("US");
    expect(locale.locationCode).not.toBeNull();
    expect(locale.unresolved).toBeNull();
  });

  it("honours a stated market over any measurement", async () => {
    // An inferred market must never override what the owner said, and must never be
    // indistinguishable from it.
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: noImpressions,
      siteId: "site-1",
      projectId: "project-1",
      context: context({ audienceCountry: "MX" }),
      deps: {} as never,
    });
    expect(locale.country).toBe("MX");
    expect(locale.marketSource).not.toBe("measured");
  });
});

describe("the locale type makes the obligation visible", () => {
  it("distinguishes an unresolved market from every stated one", () => {
    // A compile-time guarantee that a reader cannot mistake "we could not name a market" for
    // "the owner told us". `unresolved` is the only state that may carry a null country.
    const states: BundleLocale["marketSource"][] = ["override", "audience", "business", "measured", "unresolved"];
    expect(states).toContain("unresolved");
    expect(states).toHaveLength(5);
  });
});
