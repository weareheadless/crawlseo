import { describe, expect, it } from "vitest";

import { pageGap, profileFromSnapshot, type PageProfile } from "@/lib/funnel/page-gap";

/**
 * CMP-006's comparison.
 *
 * The rule this file protects: the diff reports **numbers and their differences**,
 * not verdicts. There is no "under 800 words is thin" threshold anywhere, because
 * that is a guess about someone else's business. The only judgement is whether a
 * difference exists at all — "no measurable deficit" is a real, useful answer.
 */

const now = new Date("2026-11-24T00:00:00Z");

function page(over: Partial<PageProfile> = {}): PageProfile {
  return {
    url: "https://example.com/page",
    domain: "example.com",
    position: null,
    title: "t",
    wordCount: 500,
    h1Count: 1,
    headings: ["One"],
    hasSchema: false,
    schemaTypes: [],
    internalLinks: null,
    lastModified: null,
    fetchedAt: now,
    ...over,
  };
}

const ours = page({ url: "https://site.com/ours", domain: "site.com", wordCount: 420, headings: ["A"] });

describe("CMP-006 page gap: numbers, not verdicts", () => {
  it("reports the word-count difference in both directions", () => {
    const result = pageGap({
      ours,
      competitors: [page({ domain: "rival.com", position: 2, wordCount: 1840 })],
      now,
    });
    const words = result.deficits.find((row) => row.kind === "word_count");
    expect(words?.theirs).toBe(1840);
    expect(words?.ours).toBe(420);
    expect(words?.difference).toBe(1420);
    expect(words?.sentence).toContain("1,840");
    expect(words?.sentence).toContain("420");
  });

  it("uses the median competitor, so one outlier does not set the standard", () => {
    const result = pageGap({
      ours,
      competitors: [
        page({ domain: "a.com", wordCount: 300 }),
        page({ domain: "b.com", wordCount: 1000 }),
        page({ domain: "c.com", wordCount: 9000 }),
      ],
      now,
    });
    const words = result.deficits.find((row) => row.kind === "word_count");
    // Median of 300/1000/9000 is 1000, not the 9000 outlier.
    expect(words?.theirs).toBe(1000);
  });

  it("says no measurable deficit rather than inventing one", () => {
    const strong = page({
      url: "https://site.com/ours",
      domain: "site.com",
      wordCount: 2000,
      headings: ["A", "B", "C", "D"],
      schemaTypes: ["Product"],
    });
    const result = pageGap({
      ours: strong,
      competitors: [page({ domain: "rival.com", wordCount: 800, headings: ["A"], schemaTypes: [] })],
      now,
    });
    expect(result.deficits).toEqual([]);
    expect(result.summary).toContain("No measurable deficit");
    // A page that is already stronger is not given work to do.
    expect(result.pageStrength).toBe(1);
  });

  it("names the missing schema type, not just that schema is missing", () => {
    const result = pageGap({
      ours,
      competitors: [page({ domain: "rival.com", schemaTypes: ["Product", "Offer"] })],
      now,
    });
    const schema = result.deficits.find((row) => row.kind === "schema");
    expect(schema?.theirs).toBe("Product, Offer");
    expect(schema?.ours).toBe("none");
    expect(schema?.sentence).toContain("Product");
  });

  it("names headings the better-structured page uses", () => {
    const result = pageGap({
      ours,
      competitors: [page({ domain: "rival.com", headings: ["What is it", "How much", "Where", "FAQ"] })],
      now,
    });
    const headings = result.deficits.find((row) => row.kind === "headings");
    expect(headings?.theirs).toBe(4);
    expect(headings?.ours).toBe(1);
    expect(headings?.difference).toBe(3);
  });

  it("only reports freshness when both dates are known", () => {
    // An unknown last-modified is not "old"; treating it as old would invent a
    // deficit from an absence.
    const unknown = pageGap({
      ours,
      competitors: [page({ domain: "rival.com", lastModified: new Date("2026-11-01") })],
      now,
    });
    expect(unknown.deficits.some((row) => row.kind === "freshness")).toBe(false);

    const known = pageGap({
      ours: page({ ...ours, lastModified: new Date("2025-01-01") }),
      competitors: [page({ domain: "rival.com", lastModified: new Date("2026-11-01") })],
      now,
    });
    const freshness = known.deficits.find((row) => row.kind === "freshness");
    expect(freshness?.difference).toBeGreaterThan(600);
    expect(freshness?.sentence).toContain("days after ours");
  });

  it("does not fabricate an internal-link count when neither side recorded it", () => {
    // internal_link_graph is empty in this codebase; a number here would be invented.
    const result = pageGap({
      ours,
      competitors: [page({ domain: "rival.com", internalLinks: null })],
      now,
    });
    expect(result.deficits.some((row) => row.kind === "internal_links")).toBe(false);
  });

  it("compares internal links when both sides did measure them", () => {
    const result = pageGap({
      ours: page({ ...ours, internalLinks: 4 }),
      competitors: [page({ domain: "rival.com", internalLinks: 22 })],
      now,
    });
    const links = result.deficits.find((row) => row.kind === "internal_links");
    expect(links?.difference).toBe(18);
  });
});

describe("CMP-006 page strength is measured, never 0.5", () => {
  it("returns null with a stated reason when our page is not crawled", () => {
    const result = pageGap({ ours: null, competitors: [page()], now });
    expect(result.pageStrength).toBeNull();
    expect(result.pageStrengthReason).toContain("has not been crawled");
  });

  it("returns null with a stated reason when no competitor could be read", () => {
    const result = pageGap({
      ours,
      competitors: [page({ url: "https://x.test/a", unreadable: "HTTP 403" })],
      now,
    });
    expect(result.pageStrength).toBeNull();
    expect(result.pageStrengthReason).toContain("no competitor page could be read");
    expect(result.unreadable).toHaveLength(1);
  });

  it("computes the factor from the dimensions it could measure", () => {
    // 3 dimensions measurable, ours wins 1 of them → 1/3.
    const result = pageGap({
      ours: page({ ...ours, wordCount: 2000, headings: ["A"], schemaTypes: [] }),
      competitors: [page({ domain: "rival.com", wordCount: 800, headings: ["A", "B", "C"], schemaTypes: ["Product"] })],
      now,
    });
    expect(result.pageStrength).toBeCloseTo(1 / 3, 2);
  });
});

describe("CMP-006 unreadable competitors", () => {
  it("keeps the readable pages and records the reason for each failure", () => {
    const result = pageGap({
      ours,
      competitors: [
        page({ url: "https://a.test/", domain: "a.test", wordCount: 1800 }),
        page({ url: "https://waf.test/", domain: "waf.test", unreadable: "HTTP 403" }),
        page({ url: "https://gone.test/", domain: "gone.test", unreadable: "HTTP 404" }),
      ],
      now,
    });
    expect(result.readable).toHaveLength(1);
    expect(result.unreadable).toEqual([
      { url: "https://waf.test/", reason: "HTTP 403" },
      { url: "https://gone.test/", reason: "HTTP 404" },
    ]);
    // The comparison still happens with the one page that could be read.
    expect(result.deficits.some((row) => row.kind === "word_count")).toBe(true);
  });

  it("names the strongest competitor in the summary line", () => {
    const result = pageGap({
      ours,
      competitors: [
        page({ domain: "weak.com", position: 4, wordCount: 500 }),
        page({ domain: "interieurlumiere.com", position: 2, wordCount: 1840, schemaTypes: ["Product"] }),
      ],
      now,
    });
    expect(result.summary).toContain("interieurlumiere.com");
    expect(result.summary).toContain("Product");
    // The deficit sentence states both sides; the summary names who is winning.
    expect(result.summary).toContain("median of 1,840 words");
  });
});

describe("CMP-006 reading a crawler snapshot", () => {
  it("translates a snapshot without inventing schema types", () => {
    const profile = profileFromSnapshot(
      {
        url: "https://rival.com/x",
        statusCode: 200,
        redirectUrl: null,
        title: "A page",
        description: null,
        h1s: ["One", "Two"],
        canonical: null,
        robotsMeta: null,
        wordCount: 1200,
        contentScore: 70,
        internalOutlinks: ["https://rival.com/a", "https://rival.com/b"],
        externalOutlinks: [],
        links: [],
        hasSchema: true,
        hreflangTags: [],
        imageCount: 0,
        imagesMissingAlt: 0,
        bytes: 1,
        loadMs: 1,
        contentHash: "x",
        contentText: "",
        indexable: true,
      },
      { domain: "rival.com", position: 3 },
    );
    expect(profile.wordCount).toBe(1200);
    expect(profile.h1Count).toBe(2);
    expect(profile.internalLinks).toBe(2);
    expect(profile.position).toBe(3);
    // The crawler records presence, not the declared type: an empty list is honest.
    expect(profile.hasSchema).toBe(true);
    expect(profile.schemaTypes).toEqual([]);
  });
});
