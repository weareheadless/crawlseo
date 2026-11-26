import { describe, expect, it } from "vitest";

import { resolveBundleLocale } from "@/lib/research/monthly-bundle";
import type { SiteContext } from "@/lib/site/context";

/**
 * A site with no stated market could not buy evidence, because the bundle throws without
 * a country. Search Console has been recording the country on every impression all
 * along, so the audience itself can supply one — but only when the measurement actually
 * supports a market claim.
 *
 * The order matters and is asserted here: **stated sources first, measured second, throw
 * last.** An inferred market must never override the owner saying where they sell, and it
 * must never be indistinguishable from it. `marketSource: "measured"` is how a reader
 * tells an inferred market from a stated one.
 */

function context(over: Partial<SiteContext> = {}): SiteContext {
  return {
    siteId: "site-1",
    projectId: "project-1",
    domain: "www.example.com",
    language: "en",
    country: null,
    market: null,
    location: null,
    audienceMarket: null,
    audienceCountry: null,
    audienceCountries: [],
    audienceLanguages: ["en"],
    topics: [],
    audience: null,
    source: {
      language: "site_profile",
      country: "unknown",
      location: "unknown",
      audienceCountry: "unknown",
    },
    ...over,
  } as SiteContext;
}

/** A db whose only job is the keyword read. */
function db(rows: { country: string; impressions: number }[]) {
  return { keyword: { findMany: async () => rows } } as never;
}

describe("the audience supplies a market only when the measurement supports one", () => {
  it("names the measured market, and says it was measured", async () => {
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: db([
        { country: "usa", impressions: 39372 },
        { country: "mex", impressions: 18551 },
        { country: "can", impressions: 8238 },
      ]),
      siteId: "site-1",
      projectId: "project-1",
      context: context(),
      deps: {} as never,
    });
    // Search Console writes `usa`; the location map and the rest of the bundle speak
    // alpha-2, so the resolved market is `US`. Translating the code is a fact; naming the
    // market at all is the judgement, and `marketSource` says it was inferred.
    expect(locale.country).toBe("US");
    expect(locale.marketSource).toBe("measured");
  });

  it("prefers a stated audience market over the measured one", async () => {
    // The owner said US; the measurement says FR. The owner wins, because they know where
    // they sell and the measurement only knows who happened to arrive.
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: db([{ country: "fra", impressions: 9000 }]),
      siteId: "site-1",
      projectId: "project-1",
      context: context({ audienceCountry: "US", audienceMarket: "United States" }),
      deps: {} as never,
    });
    expect(locale.country).toBe("US");
    expect(locale.marketSource).toBe("audience");
  });

  it("prefers a stated business country over the measured one", async () => {
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: db([{ country: "fra", impressions: 9000 }]),
      siteId: "site-1",
      projectId: "project-1",
      context: context({ country: "MX", market: "Mexico" }),
      deps: {} as never,
    });
    expect(locale.marketSource).toBe("business");
    expect(locale.country).toBe("MX");
  });

  it("names no market when the audience is too scattered, and says how", async () => {
    // alaguillotine's real shape: 136 impressions over 31 countries, USA at 35%. Above the
    // volume floor and above the share floor, and still not a market.
    //
    // This resolves to an *unresolved* locale rather than throwing. Throwing refused the
    // whole bundle, which also discarded keyword discovery — the one section that needs no
    // market and is the reason the research path exists for a site with no history. The
    // priced sections are the part that must not run, and they refuse individually.
    const scattered = [
      { country: "usa", impressions: 48 },
      { country: "fra", impressions: 16 },
      { country: "deu", impressions: 12 },
      ...Array.from({ length: 28 }, (_, i) => ({ country: `c${i}`, impressions: 2 })),
    ];
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: db(scattered),
      siteId: "site-1",
      context: context(),
      projectId: "project-1",
      deps: {} as never,
    });
    expect(locale.marketSource).toBe("unresolved");
    expect(locale.country).toBeNull();
    expect(locale.locationCode).toBeNull();
    expect(locale.unresolved).toMatch(/scattered/);
    expect(locale.unresolved).toMatch(/state one instead/);
  });

  it("names no market when nothing was ever measured, and says that instead", async () => {
    // superincompetence: 0 impressions. No measurement can supply a market, and guessing
    // one from `.com` or `en` is the deterministic fallback this project bans.
    //
    // The two reasons stay distinct because they need different actions: "new or unwired"
    // is fixed by connecting Search Console, "scattered" by stating a market.
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: db([]),
      siteId: "site-1",
      projectId: "project-1",
      context: context(),
      deps: {} as never,
    });
    expect(locale.marketSource).toBe("unresolved");
    expect(locale.unresolved).toMatch(/no Search Console history/);
  });

  it("still works when the read fails, if a market was stated", async () => {
    // A read failure is not a reason to refuse a bundle whose market is already known.
    const failing = {
      keyword: {
        findMany: async () => {
          throw new Error("connection reset");
        },
      },
    } as never;
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: failing,
      siteId: "site-1",
      projectId: "project-1",
      context: context({ audienceCountry: "US", audienceMarket: "United States" }),
      deps: {} as never,
    });
    expect(locale.marketSource).toBe("audience");
  });

  it("does not query the audience when a market was stated", async () => {
    // Stated sources are decided first, so the read never runs. Asserted with a db that
    // would throw if touched.
    const untouched = {
      keyword: {
        findMany: async () => {
          throw new Error("should not be read");
        },
      },
    } as never;
    const locale = await resolveBundleLocale({
      mode: "dry-run",
      db: untouched,
      siteId: "site-1",
      projectId: "project-1",
      context: context({ audienceCountry: "US", audienceMarket: "United States" }),
      deps: {} as never,
    });
    expect(locale.country).toBe("US");
  });
});
