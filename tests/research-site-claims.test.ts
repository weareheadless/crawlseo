import { describe, expect, it } from "vitest";

import {
  normalizePageType,
  verifyClaimedFindings,
  verifySiteClaim,
  type PageTypeInventory,
  type SiteClaim,
} from "@/lib/research/site-claims";

/**
 * Casamigo's board carried: "the site has no city-level entry point", while the
 * crawl held thirteen city pages. The claim was prose, so nothing checked it.
 */
const casamigo: PageTypeInventory[] = [
  { type: "property", pages: 439, sample: "https://www.casamigo.net/property/aak-tulum" },
  { type: "cities", pages: 13, sample: "https://www.casamigo.net/cities/tulum" },
  { type: "collections", pages: 8 },
  { type: "post", pages: 16 },
];

const claim = (over: Partial<SiteClaim>): SiteClaim => ({
  kind: "missing_page_type",
  pageType: "cities",
  statement: "The site has no city-level entry point.",
  ...over,
});

describe("page type normalisation", () => {
  it("treats spelling and path variants as one type", () => {
    expect(normalizePageType("cities")).toBe("city");
    expect(normalizePageType("City")).toBe("city");
    expect(normalizePageType("/cities/")).toBe("city");
    expect(normalizePageType("https://www.casamigo.net/cities/tulum")).toBe("city");
    expect(normalizePageType("properties")).toBe("property");
  });
});

describe("claim verification", () => {
  it("contradicts a missing city page when the crawl has city pages", () => {
    const result = verifySiteClaim(claim({}), casamigo);
    expect(result.status).toBe("contradicted");
    expect(result.reason).toContain("13 cities page(s)");
    expect(result.reason).toContain("/cities/tulum");
  });

  it("supports a missing page type the inventory does not have", () => {
    const result = verifySiteClaim(claim({ pageType: "comparison" }), casamigo);
    expect(result.status).toBe("supported");
  });

  it("never treats an answer or offer claim as proven absence", () => {
    expect(verifySiteClaim(claim({ kind: "missing_answer", pageType: null }), casamigo).status).toBe("unverified");
    expect(verifySiteClaim(claim({ kind: "absent_offering", pageType: null }), casamigo).status).toBe("unverified");
  });

  it("is unverified when the claim names no page type", () => {
    expect(verifySiteClaim(claim({ pageType: null }), casamigo).status).toBe("unverified");
  });
});

describe("applying verification to a batch", () => {
  const finding = (theme: string, siteClaim: SiteClaim | null) => ({ theme, summary: `Summary for ${theme}`, siteClaim });

  it("drops a contradicted finding and keeps the rest", () => {
    const result = verifyClaimedFindings(
      [
        finding("Portal framing vs city pages", claim({})),
        finding("Ownership FAQ", null),
        finding("Mexico City coverage", claim({ pageType: "mexico-city-inventory", statement: "No Mexico City inventory." })),
      ],
      casamigo
    );
    expect(result.kept.map((row) => row.theme)).toEqual(["Ownership FAQ", "Mexico City coverage"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].verification.reason).toContain("13 cities");
  });

  it("labels a finding with no claim rather than assuming it is proven", () => {
    const result = verifyClaimedFindings([finding("Ownership FAQ", null)], casamigo);
    expect(result.kept[0].verification.status).toBe("unverified");
  });

  it("keeps an unverified absence claim visible but marked", () => {
    const result = verifyClaimedFindings(
      [finding("Custom lampshade page", claim({ kind: "missing_answer", pageType: null, statement: "No page covers custom lampshades." }))],
      casamigo
    );
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].verification.status).toBe("unverified");
  });
});
