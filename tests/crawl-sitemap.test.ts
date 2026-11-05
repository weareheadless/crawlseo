import { describe, expect, it } from "vitest";

import { collectSitemapUrls, sitemapKey } from "@/lib/crawler/engine";

const ORIGIN = "https://www.example.com";

function urlset(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((url) => `<url><loc>${url}</loc></url>`)
    .join("")}</urlset>`;
}

function index(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((url) => `<sitemap><loc>${url}</loc></sitemap>`)
    .join("")}</sitemapindex>`;
}

function fetcher(documents: Record<string, string>) {
  return async (url: string) => documents[url] ?? null;
}

describe("sitemap discovery", () => {
  it("reads every child of a sitemap index, not a fixed number of them", async () => {
    const documents: Record<string, string> = {
      [`${ORIGIN}/sitemap.xml`]: index(
        Array.from({ length: 8 }, (_, i) => `${ORIGIN}/child-${i}.xml`)
      ),
    };
    for (let i = 0; i < 8; i += 1) {
      documents[`${ORIGIN}/child-${i}.xml`] = urlset([`${ORIGIN}/page-${i}`]);
    }
    const urls = await collectSitemapUrls(fetcher(documents), ORIGIN, null);
    expect(urls).toContain(`${ORIGIN}/page-0`);
    expect(urls).toContain(`${ORIGIN}/page-7`);
    expect(urls).toHaveLength(8);
  });

  it("follows a nested index", async () => {
    const documents: Record<string, string> = {
      [`${ORIGIN}/sitemap.xml`]: index([`${ORIGIN}/nested.xml`]),
      [`${ORIGIN}/nested.xml`]: index([`${ORIGIN}/pages.xml`]),
      [`${ORIGIN}/pages.xml`]: urlset([`${ORIGIN}/lampes`, `${ORIGIN}/les-tissus`]),
    };
    const urls = await collectSitemapUrls(fetcher(documents), ORIGIN, null);
    expect(urls).toEqual([`${ORIGIN}/lampes`, `${ORIGIN}/les-tissus`]);
  });

  it("uses every sitemap named in robots.txt", async () => {
    const documents: Record<string, string> = {
      [`${ORIGIN}/products.xml`]: urlset([`${ORIGIN}/product-page/a`]),
      [`${ORIGIN}/pages.xml`]: urlset([`${ORIGIN}/lampes`]),
    };
    const robots = `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/products.xml\nSitemap: ${ORIGIN}/pages.xml\n`;
    const urls = await collectSitemapUrls(fetcher(documents), ORIGIN, robots);
    expect(urls).toContain(`${ORIGIN}/product-page/a`);
    expect(urls).toContain(`${ORIGIN}/lampes`);
  });

  it("stops on a document that is both an index and a urlset without looping", async () => {
    const documents: Record<string, string> = {
      [`${ORIGIN}/sitemap.xml`]: index([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/pages.xml`]),
      [`${ORIGIN}/pages.xml`]: urlset([`${ORIGIN}/lampes`]),
    };
    const urls = await collectSitemapUrls(fetcher(documents), ORIGIN, null);
    expect(urls).toEqual([`${ORIGIN}/lampes`]);
  });
});

describe("sitemap URL comparison", () => {
  it("treats www, trailing slash and percent-encoding as the same page", () => {
    expect(sitemapKey("https://example.com/lampes/")).toBe(sitemapKey("https://www.example.com/lampes"));
    expect(sitemapKey("https://www.example.com/abat-jour-%C3%A0-poser")).toBe(
      sitemapKey("https://www.example.com/abat-jour-à-poser")
    );
  });

  it("keeps distinct pages distinct", () => {
    expect(sitemapKey("https://www.example.com/lampes")).not.toBe(
      sitemapKey("https://www.example.com/lampes/abat-jours")
    );
    expect(sitemapKey("https://www.example.com/lampes?page=2")).not.toBe(
      sitemapKey("https://www.example.com/lampes")
    );
  });
});
