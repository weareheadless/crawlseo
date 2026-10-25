import { describe, expect, it } from "vitest";
import { buildCrawlActionDrafts } from "@/lib/research/crawl-actions";

const site = { domain: "www.example.com" };
const crawl = { id: "crawl-1", pagesFound: 100 };

function page(url: string, statusCode = 200) {
  return {
    url,
    title: `Title ${url}`,
    description: `Description ${url}`,
    wordCount: 500,
    contentScore: 70,
    h1Count: 1,
    statusCode,
  };
}

describe("crawl action generation", () => {
  it("groups crawl issues into actionable technical work", () => {
    const duplicateUrls = [
      "https://www.example.com/blog",
      "https://www.example.com/blog/hashtags/1",
      "https://www.example.com/blog/hashtags/2",
    ];
    const issues = [
      { url: "https://www.example.com/city-a", type: "MISSING_H1", severity: "WARNING", message: "No H1 heading found", details: { howToFix: "Add an H1." } },
      { url: "https://www.example.com/city-b", type: "MISSING_H1", severity: "WARNING", message: "No H1 heading found", details: { howToFix: "Add an H1." } },
      { url: "https://www.example.com/post/a", type: "MISSING_H1", severity: "WARNING", message: "No H1 heading found", details: {} },
      { url: "https://www.example.com/post/b", type: "MISSING_H1", severity: "WARNING", message: "No H1 heading found", details: {} },
      { url: "https://www.example.com/blog/hashtags/1", type: "BROKEN_LINK", severity: "CRITICAL", message: "HTTP 404", details: { statusCode: 404 } },
      { url: "https://www.example.com/blog/hashtags/2", type: "BROKEN_LINK", severity: "CRITICAL", message: "HTTP 404", details: { statusCode: 404 } },
      { url: "https://www.example.com/real-estate-listings/a", type: "BROKEN_LINK", severity: "CRITICAL", message: "HTTP 429", details: { statusCode: 429 } },
      { url: duplicateUrls[0], type: "DUPLICATE_TITLE", severity: "WARNING", message: "Duplicate title shared by 3 pages", details: { urls: duplicateUrls } },
      { url: duplicateUrls[1], type: "DUPLICATE_TITLE", severity: "WARNING", message: "Duplicate title shared by 3 pages", details: { urls: duplicateUrls } },
      { url: "https://www.example.com/blog/tags/a", type: "MISSING_SITEMAP", severity: "INFO", message: "Crawled page not listed in sitemap", details: { kind: "not_in_sitemap" } },
      { url: "https://www.example.com/blog/tags/b", type: "MISSING_SITEMAP", severity: "INFO", message: "Crawled page not listed in sitemap", details: { kind: "not_in_sitemap" } },
      { url: "https://www.example.com/post/a", type: "MISSING_DESCRIPTION", severity: "INFO", message: "On-page content score 40/100", details: { kind: "content_score" } },
    ];
    const sourcePost = "https://www.example.com/post/riviera-maya-real-estate-analysis";
    const pages = [...new Set([...issues.map((issue) => issue.url), sourcePost])].map((url) => page(url));
    const links = [
      { sourceUrl: sourcePost, targetUrl: "https://www.example.com/blog/hashtags/1", anchorText: "#1", statusCode: null },
      { sourceUrl: sourcePost, targetUrl: "https://www.example.com/blog/hashtags/2", anchorText: "#2", statusCode: null },
    ];

    const drafts = buildCrawlActionDrafts({ site, crawl, issues, pages, links });

    expect(drafts).toHaveLength(5);
    expect(drafts.every((draft) => draft.dedupeKey.startsWith("crawl:"))).toBe(true);

    const h1 = drafts.find((draft) => draft.issueType === "MISSING_H1");
    expect(h1?.groupKey).toBe("MISSING_H1:all-pages");
    expect(h1?.affectedPages).toBe(4);
    expect(h1?.targetUrl).toMatch(/city-[ab]/);
    expect(h1?.evidence.batch).toBe(true);
    expect(h1?.evidence.route_families).toEqual(expect.arrayContaining(["landing pages", "blog post template"]));

    const broken404 = drafts.find((draft) => draft.issueType === "BROKEN_LINK" && draft.groupKey.startsWith("BROKEN_LINK:broken:404:source:"));
    expect(broken404?.affectedPages).toBe(2);
    expect(broken404?.priority).toBeGreaterThan(70);
    expect(broken404?.targetUrl).toBe(sourcePost);
    expect(broken404?.kind).toBe("fix_broken_link");
    expect(broken404?.fixMode).toBe("blog_content");
    expect(broken404?.evidence.technical).toBe(false);
    expect(broken404?.recommendation).toContain("Wix Blog");

    const broken429 = drafts.find((draft) => draft.issueType === "BROKEN_LINK" && draft.groupKey === "BROKEN_LINK:broken:429:listing-detail");
    expect(broken429?.severity).toBe("INFO");
    expect(broken429?.kind).toBe("fix_technical_issue");
    expect(broken429?.priority).toBe(35);
    expect(broken429?.recommendation).toContain("HTTP 429");
    expect(broken429?.recommendation).toContain("throttling");

    const duplicate = drafts.find((draft) => draft.issueType === "DUPLICATE_TITLE");
    expect(duplicate?.affectedPages).toBe(3);
    expect(duplicate?.evidence.urls).toEqual(duplicateUrls);
    expect(duplicate?.dedupeKey).toMatch(/^crawl:DUPLICATE_TITLE:duplicate:/);

    const sitemap = drafts.find((draft) => draft.issueType === "MISSING_SITEMAP");
    expect(sitemap?.affectedPages).toBe(2);
    expect(sitemap?.groupLabel).toBe("site-wide");

    expect(drafts.some((draft) => draft.evidence.message === "On-page content score 40/100")).toBe(false);
  });

  it("batches page-level H1 fixes into one action", () => {
    const indexUrl = "https://www.example.com/real-estate-listings";
    const detailUrl = "https://www.example.com/real-estate-listings/example-condo";
    const drafts = buildCrawlActionDrafts({
      site,
      crawl,
      issues: [
        { url: indexUrl, type: "MISSING_H1", severity: "WARNING", message: "No H1 heading found", details: {} },
        { url: detailUrl, type: "MISSING_H1", severity: "WARNING", message: "No H1 heading found", details: {} },
      ],
      pages: [page(indexUrl), { ...page(detailUrl), h1Count: 0 }],
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].groupKey).toBe("MISSING_H1:all-pages");
    expect(drafts[0].affectedPages).toBe(2);
    expect(drafts[0].targetUrl).toBe(indexUrl);
    expect(drafts[0].evidence.batch).toBe(true);
    expect(drafts[0].evidence.route_families).toEqual(["listing index", "listing detail template"]);
  });

  it("ignores content issues recorded on rate-limit pages", () => {
    const url = "https://www.example.com/post/rate-limited";
    const drafts = buildCrawlActionDrafts({
      site,
      crawl,
      issues: [
        { url, type: "DUPLICATE_TITLE", severity: "WARNING", message: "Duplicate title shared by 155 pages", details: { title: "Checking Your Request", urls: [url] } },
        { url, type: "MISSING_H1", severity: "WARNING", message: "No H1 heading found", details: {} },
      ],
      pages: [page(url, 429)],
    });
    expect(drafts).toEqual([]);
  });

  it("returns no actions when there is no crawl evidence", () => {
    expect(buildCrawlActionDrafts({ site, crawl, issues: [], pages: [] })).toEqual([]);
  });
});
