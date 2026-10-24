import type { CrawlActionDraft } from "@/lib/research/crawl-actions";

const LIVE_CHECKABLE = new Set([
  "MISSING_H1",
  "MULTIPLE_H1",
  "MISSING_TITLE",
  "MISSING_DESCRIPTION",
  "MISSING_CANONICAL",
  "MISSING_SCHEMA",
  "MISSING_ALT",
]);
const LIVE_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export type CrawlLiveCheck = {
  checked_at: string;
  status: number | null;
  issue_type: string;
  issue_reproduced: boolean | null;
  h1_count?: number | null;
  title_present?: boolean;
  description_present?: boolean;
  canonical_present?: boolean;
  schema_present?: boolean;
  images_missing_alt?: number;
  image_count?: number;
  reason?: string;
};

function extractTag(html: string, pattern: RegExp): string | null {
  return html.match(pattern)?.[1]?.trim() || null;
}

export function liveCheckFromHtml(issueType: string, html: string): Omit<CrawlLiveCheck, "checked_at" | "status" | "issue_type"> {
  const h1Count = [...html.matchAll(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi)].length;
  const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = extractTag(
    html,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  ) || extractTag(
    html,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
  );
  const canonical = extractTag(
    html,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
  ) || extractTag(
    html,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
  );
  const hasSchema = /application\/ld\+json/i.test(html)
    || /\bitemscope\b/i.test(html)
    || /\bitemtype\b/i.test(html);
  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const imagesMissingAlt = imgTags.filter((tag) => !/\balt\s*=\s*["'][^"']+["']/i.test(tag)).length;

  let issueReproduced: boolean | null = null;
  if (issueType === "MISSING_H1") issueReproduced = h1Count === 0;
  else if (issueType === "MULTIPLE_H1") issueReproduced = h1Count > 1;
  else if (issueType === "MISSING_TITLE") issueReproduced = !title;
  else if (issueType === "MISSING_DESCRIPTION") issueReproduced = !description;
  else if (issueType === "MISSING_CANONICAL") issueReproduced = !canonical;
  else if (issueType === "MISSING_SCHEMA") issueReproduced = !hasSchema;
  else if (issueType === "MISSING_ALT") issueReproduced = imagesMissingAlt > 0;

  return {
    h1_count: h1Count,
    title_present: Boolean(title),
    description_present: Boolean(description),
    canonical_present: Boolean(canonical),
    schema_present: hasSchema,
    images_missing_alt: imagesMissingAlt,
    image_count: imgTags.length,
    issue_reproduced: issueReproduced,
  };
}

export async function verifyCrawlDraftLive(
  draft: CrawlActionDraft,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<CrawlLiveCheck | null> {
  if (!LIVE_CHECKABLE.has(draft.issueType)) return null;
  const checkedAt = new Date().toISOString();
  try {
    const response = await (options.fetchImpl ?? fetch)(draft.targetUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": LIVE_UA,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return {
        checked_at: checkedAt,
        status: response.status,
        issue_type: draft.issueType,
        issue_reproduced: null,
        reason: `Live page returned HTTP ${response.status}`,
      };
    }
    const html = await response.text();
    return {
      checked_at: checkedAt,
      status: response.status,
      issue_type: draft.issueType,
      ...liveCheckFromHtml(draft.issueType, html),
    };
  } catch (error) {
    return {
      checked_at: checkedAt,
      status: null,
      issue_type: draft.issueType,
      issue_reproduced: null,
      reason: error instanceof Error ? error.message.slice(0, 200) : "Live check failed",
    };
  }
}
