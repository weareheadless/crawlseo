import { createHash } from "node:crypto";

export type ResearchProviderSource = {
  provider: string;
  url: string;
  title: string;
  author?: string;
  community?: string;
  publishedAt?: string;
  excerpt?: string;
  contentHash: string;
  language?: string;
  metadata?: Record<string, unknown>;
};

export type RedditRssSearchInput = {
  query: string;
  sort?: "relevance" | "new" | "top";
  timeWindow?: "week" | "month" | "year" | "all";
  limit?: number;
};

const REDDIT_RSS_BASE = "https://www.reddit.com/search.rss";
const DEFAULT_USER_AGENT = "CrawlSEO/0.1 read-only research";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function stripMarkup(value: string): string {
  return decodeEntities(value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() ?? "";
}

function atomLink(xml: string): string {
  return decodeEntities(xml.match(/<link\b[^>]*href="([^"]+)"/i)?.[1]?.trim() ?? "");
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function safeLimit(value: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(value ?? 25), 100));
}

export function parseRedditRss(xml: string): ResearchProviderSource[] {
  if (!xml.trim()) return [];
  const sources: ResearchProviderSource[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1] ?? "";
    const url = atomLink(entry);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const title = stripMarkup(firstTag(entry, "title"));
    if (!title) continue;
    const content = stripMarkup(firstTag(entry, "content"));
    const excerpt = content.slice(0, 2_000);
    const redditId = firstTag(entry, "id");
    const authorBlock = firstTag(entry, "author");
    const author = stripMarkup(firstTag(authorBlock, "name")).replace(/^\/u\//i, "") || undefined;
    const community = url.match(/\/r\/([^/]+)/i)?.[1];
    const publishedAt = isoDate(firstTag(entry, "published") || firstTag(entry, "updated"));
    const contentHash = createHash("sha256")
      .update([redditId, url, title, excerpt].join("\n"), "utf8")
      .digest("hex");

    sources.push({
      provider: "reddit_rss",
      url,
      title,
      author,
      community: community ? `r/${community}` : undefined,
      publishedAt,
      excerpt,
      contentHash,
      metadata: {
        reddit_id: redditId || undefined,
        subreddit: community || undefined,
      },
    });
  }

  return sources;
}

export async function fetchRedditRssSearch(
  input: RedditRssSearchInput,
): Promise<ResearchProviderSource[]> {
  const query = input.query.trim();
  if (!query) throw new Error("Reddit RSS query is required");

  const params = new URLSearchParams({
    q: query,
    type: "link",
    sort: input.sort ?? "relevance",
    t: input.timeWindow ?? "year",
    limit: String(safeLimit(input.limit)),
  });
  const response = await fetch(`${REDDIT_RSS_BASE}?${params}`, {
    headers: {
      "User-Agent": process.env.REDDIT_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Reddit RSS returned HTTP ${response.status}`);
  }
  const xml = (await response.text()).slice(0, 2_000_000);
  return parseRedditRss(xml);
}
