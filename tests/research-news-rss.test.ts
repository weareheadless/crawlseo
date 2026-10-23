import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleNewsRssSearch, parseGoogleNewsRss } from "@/lib/research/providers/google-news-rss";

const XML = `<?xml version="1.0"?><rss version="2.0"><channel>
<item>
  <title>Tulum's ugly downfall is a warning for Mexico - Taipei Times</title>
  <link>https://news.google.com/rss/articles/example-1</link>
  <pubDate>Mon, 19 Oct 2026 16:00:00 GMT</pubDate>
  <description>&lt;p&gt;A report about &amp;quot;Tulum's warning&amp;quot;.&lt;/p&gt;</description>
  <source url="https://www.taipeitimes.com">Taipei Times</source>
</item>
<item>
  <title>Ontario buyer regrets unfinished Mexico condo</title>
  <link>https://news.google.com/rss/articles/example-2</link>
  <pubDate>Tue, 30 Jun 2026 07:00:00 GMT</pubDate>
  <description>Delivery risk and unfinished construction.</description>
  <source>BNN Bloomberg</source>
</item>
</channel></rss>`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Google News RSS", () => {
  it("normalizes news items with publisher and publication date", () => {
    const sources = parseGoogleNewsRss(XML);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      provider: "google_news_rss",
      title: "Tulum's ugly downfall is a warning for Mexico - Taipei Times",
    });
    expect(sources[0].publishedAt).toBe("2026-10-19T16:00:00.000Z");
    expect(sources[0].excerpt).toContain("Tulum's warning");
    expect(sources[0].metadata?.publisher).toBe("Taipei Times");
  });

  it("requests the selected locale and a user agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(XML, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("RESEARCH_USER_AGENT", "CrawlSEO test news agent");

    const sources = await fetchGoogleNewsRssSearch({
      query: "tulum real estate",
      language: "es",
      country: "MX",
      limit: 10,
    });

    expect(sources).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get("hl")).toBe("es-MX");
    expect(parsed.searchParams.get("ceid")).toBe("MX:es");
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("CrawlSEO test news agent");
  });
});
