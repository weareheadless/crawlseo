import { describe, expect, it } from "vitest";

import {
  PAGE_SELECTION_BOUNDS,
  selectPagesForExtraction,
  type CrawlPageCandidate,
} from "@/lib/projects/knowledge-page-selection";

/**
 * The extractor used to re-fetch ten URLs over HTTP and ignore the text the
 * crawl had already stored. Two of the three tenants with no country return 404
 * on /sitemap.xml, so the selection collapsed to the homepage and one page was
 * read — and the word "México" sat unread on /about.
 *
 * These tests pin the selection: bounded, ordered by what a page is for, and
 * honest about what it left out.
 */

function page(path: string, wordCount = 400, text?: string): CrawlPageCandidate {
  return {
    url: `https://example.test${path}`,
    path,
    title: null,
    wordCount,
    contentText: text ?? `${"word ".repeat(Math.max(0, wordCount))}`,
  };
}

describe("selecting pages to extract business knowledge from", () => {
  it("always takes the homepage, even when other pages look more commercial", () => {
    const selection = selectPagesForExtraction([
      page("/"),
      page("/services/fitted-wardrobes", 900),
      page("/blog/some-long-post", 2000),
    ]);
    expect(selection.selected[0].path).toBe("/");
  });

  it("prefers an about page over a deep catalogue page", () => {
    const selection = selectPagesForExtraction([
      page("/"),
      page("/property/torre-25/unit-3/floor-plan", 800),
      page("/about", 300),
    ], { maxPages: 2 });
    expect(selection.selected.map((entry) => entry.path)).toContain("/about");
    expect(selection.selected.map((entry) => entry.path)).not.toContain("/property/torre-25/unit-3/floor-plan");
  });

  it("reads every locale root once a site publishes more than one", () => {
    // inmersionfreediving publishes /, /es, /fr. The country appears on /es
    // about and nowhere on the English homepage.
    const selection = selectPagesForExtraction([
      page("/"),
      page("/es"),
      page("/fr"),
      page("/courses"),
    ]);
    const paths = selection.selected.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(["/", "/es", "/fr"]));
    expect(selection.locales).toEqual(["es", "fr"]);
  });

  it("reports a two-letter path as a locale candidate without claiming it is one", () => {
    // Path shape alone cannot tell `/es` (Spanish) from `/go` (a redirect page).
    // Deciding that is a judgment about the site, so this reports the candidate
    // and lets the extraction read the page: a wrong guess costs one of 24 slots
    // and never changes what a fact means.
    const selection = selectPagesForExtraction([page("/"), page("/go", 400)]);
    expect(selection.locales).toEqual(["go"]);
    expect(selection.selected.length).toBeLessThanOrEqual(2);
  });

  it("skips stubs and says how many", () => {
    const selection = selectPagesForExtraction([
      page("/"),
      page("/thin", 5),
      page("/also-thin", 3),
    ]);
    expect(selection.selected.map((entry) => entry.path)).toEqual(["/"]);
    expect(selection.skipped.pages).toBe(2);
    expect(selection.skipped.reason).toContain("fewer than");
  });

  it("bounds the page count and reports what was not sent", () => {
    const pages = [page("/"), ...Array.from({ length: 60 }, (_, index) => page(`/services/s${index}`, 500))];
    const selection = selectPagesForExtraction(pages, { maxPages: 5 });
    expect(selection.selected).toHaveLength(5);
    expect(selection.skipped.pages).toBe(56);
    expect(selection.skipped.reason).toContain("not sent");
  });

  it("bounds the total characters, not just the page count", () => {
    // 24 pages of 6,000 characters is 144,000, above the 90,000 bound.
    const pages = [page("/"), ...Array.from({ length: 30 }, (_, index) => page(`/services/s${index}`, 3000))];
    const selection = selectPagesForExtraction(pages);
    const total = selection.selected.reduce((sum, entry) => sum + entry.text.length, 0);
    expect(total).toBeLessThanOrEqual(PAGE_SELECTION_BOUNDS.maxTotalChars);
    expect(selection.selected.length).toBeLessThan(PAGE_SELECTION_BOUNDS.maxPages);
    expect(selection.skipped.reason).toContain("character bound");
  });

  it("says so when the crawl stored no text at all", () => {
    const selection = selectPagesForExtraction([page("/", 400, "")]);
    expect(selection.selected).toEqual([]);
    expect(selection.skipped.reason).toContain("no page text");
  });

  it("cuts a page at the per-page bound rather than dropping it", () => {
    const long = page("/about", 50_000, "x".repeat(50_000));
    const selection = selectPagesForExtraction([page("/"), long]);
    const about = selection.selected.find((entry) => entry.path === "/about");
    expect(about?.text).toHaveLength(PAGE_SELECTION_BOUNDS.maxCharsPerPage);
  });

  it("never selects the same path twice", () => {
    const selection = selectPagesForExtraction([page("/"), page("/about"), page("/about")]);
    const paths = selection.selected.map((entry) => entry.path);
    expect(paths).toHaveLength(new Set(paths).size);
  });
});
