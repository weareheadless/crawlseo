import { createHash } from "node:crypto";
import type { ResearchProviderSource } from "@/lib/research/providers/reddit-rss";

const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
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

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function parseGoogleNewsRss(xml: string): ResearchProviderSource[] {
  if (!xml.trim()) return [];
  const sources: ResearchProviderSource[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = match[1] ?? "";
    const url = stripMarkup(firstTag(item, "link"));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = stripMarkup(firstTag(item, "title"));
    if (!title) continue;
    const excerpt = stripMarkup(firstTag(item, "description")).slice(0, 2_000);
    const publisher = stripMarkup(firstTag(item, "source")) || undefined;
    const publishedAt = isoDate(firstTag(item, "pubDate"));
    const contentHash = createHash("sha256")
      .update([url, title, publishedAt ?? "", excerpt].join("\n"), "utf8")
      .digest("hex");

    sources.push({
      provider: "google_news_rss",
      url,
      title,
      publishedAt,
      excerpt,
      contentHash,
      metadata: { publisher },
    });
  }

  return sources;
}

export async function fetchGoogleNewsRssSearch(input: {
  query: string;
  limit?: number;
  language?: string;
  country?: string;
}): Promise<ResearchProviderSource[]> {
  const query = input.query.trim();
  if (!query) throw new Error("Google News RSS query is required");
  const language = (input.language || "en").trim();
  const country = (input.country || "US").trim().toUpperCase();
  const params = new URLSearchParams({
    q: query,
    hl: `${language}-${country}`,
    gl: country,
    ceid: `${country}:${language}`,
  });
  const response = await fetch(`${GOOGLE_NEWS_RSS}?${params}`, {
    headers: {
      "User-Agent": process.env.RESEARCH_USER_AGENT?.trim()
        || process.env.REDDIT_USER_AGENT?.trim()
        || DEFAULT_USER_AGENT,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Google News RSS returned HTTP ${response.status}`);
  const xml = (await response.text()).slice(0, 2_000_000);
  return parseGoogleNewsRss(xml).slice(0, Math.max(1, Math.min(Math.floor(input.limit ?? 20), 50)));
}
