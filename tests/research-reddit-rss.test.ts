import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRedditRssSearch,
  parseRedditRss,
} from "@/lib/research/providers/reddit-rss";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Is it worth investing in Tulum real-estate in 2026? (from USA)</title>
    <link href="https://www.reddit.com/r/tulum/comments/abc123/is_it_worth_investing/" />
    <updated>2026-10-20T12:00:00+00:00</updated>
    <id>t3_abc123</id>
    <author><name>/u/example_user</name></author>
    <content type="html">&lt;div&gt;I keep reading about &amp;quot;ownership&amp;quot; and safety.&lt;/div&gt;</content>
  </entry>
  <entry>
    <title>Same post</title>
    <link href="https://www.reddit.com/r/tulum/comments/abc123/is_it_worth_investing/" />
    <updated>2026-10-20T12:00:00+00:00</updated>
    <id>t3_abc123</id>
    <content type="html">duplicate</content>
  </entry>
  <entry>
    <title>Cancun condo fees &amp; taxes</title>
    <link href="https://www.reddit.com/r/AskMexico/comments/def456/condo_fees/" />
    <updated>2026-10-19T08:30:00+00:00</updated>
    <id>t3_def456</id>
    <author><name>/u/another_user</name></author>
    <content type="html">&lt;p&gt;What should a buyer budget?&lt;/p&gt;</content>
  </entry>
</feed>`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Reddit RSS parsing", () => {
  it("normalizes entries and deduplicates by URL", () => {
    const sources = parseRedditRss(XML);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      provider: "reddit_rss",
      title: "Is it worth investing in Tulum real-estate in 2026? (from USA)",
      community: "r/tulum",
      author: "example_user",
      publishedAt: "2026-10-20T12:00:00.000Z",
    });
    expect(sources[0].excerpt).toContain("ownership");
    expect(sources[0].contentHash).toHaveLength(64);
    expect(sources[1].excerpt).toContain("What should a buyer budget?");
  });

  it("uses the Reddit post permalink as the canonical source URL", () => {
    expect(parseRedditRss(XML)[0].url).toContain("/r/tulum/comments/abc123/");
  });

  it("returns an empty list for empty or malformed input", () => {
    expect(parseRedditRss("")).toEqual([]);
    expect(parseRedditRss("<feed></feed>")).toEqual([]);
  });
});

describe("Reddit RSS fetch", () => {
  it("requests link results from search.rss", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(XML, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("REDDIT_USER_AGENT", "CrawlSEO test agent");

    const sources = await fetchRedditRssSearch({
      query: "tulum real estate",
      timeWindow: "year",
      limit: 25,
    });

    expect(sources).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("reddit.com/search.rss");
    expect(String(url)).toContain("type=link");
    expect(String(url)).toContain("q=tulum+real+estate");
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("CrawlSEO test agent");
  });

  it("surfaces Reddit rate limiting without retrying forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRedditRssSearch({ query: "tulum" })).rejects.toThrow("HTTP 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
