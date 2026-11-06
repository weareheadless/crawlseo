import { describe, expect, it } from "vitest";

import { providerCountry, type SiteContext } from "@/lib/site/context";

function context(overrides: Partial<SiteContext>): SiteContext {
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
    topics: [],
    audience: null,
    source: {
      language: "site_profile",
      country: "unknown",
      location: "unknown",
      audienceCountry: "unknown",
    },
    ...overrides,
  };
}

describe("provider country", () => {
  it("measures where the audience searches, not where the business sits", () => {
    const site = context({ country: "MX", audienceCountry: "US", audienceCountries: ["US", "CA"] });
    expect(providerCountry(site)).toBe("US");
  });

  it("falls back to the business country when no audience market is known", () => {
    expect(providerCountry(context({ country: "FR" }))).toBe("FR");
  });

  it("returns null rather than inventing a market", () => {
    expect(providerCountry(context({}))).toBeNull();
  });
});
