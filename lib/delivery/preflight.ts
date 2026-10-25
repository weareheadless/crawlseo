import { db } from "@/lib/db";

const PAGE_LEVEL_ISSUES = new Set([
  "MISSING_H1",
  "MULTIPLE_H1",
  "MISSING_TITLE",
  "MISSING_DESCRIPTION",
  "MISSING_CANONICAL",
  "MISSING_SCHEMA",
  "MISSING_ALT",
  "MIXED_CONTENT",
]);
const GLOBAL_CHROME = /(?:^|[-_])(navbar|footer|header|nav)(?:[-_]|$)/i;
const LIVE_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export type TargetPreflight = {
  supported: boolean;
  deliverable: boolean | null;
  issueType: string;
  targetUrl: string | null;
  contentTags: string[];
  presentTags: string[];
  reason: string | null;
  checkedAt: string;
};

export function contentEmbedTags(targets: Array<{ componentTag: string | null }>): string[] {
  return [...new Set(targets
    .map((target) => target.componentTag?.trim())
    .filter((tag): tag is string => Boolean(tag) && !GLOBAL_CHROME.test(tag!)))];
}

export function presentContentTags(html: string, tags: string[]): string[] {
  return tags.filter((tag) => new RegExp(`<${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(html));
}

export async function preflightTechnicalTarget(input: {
  siteId: string;
  targetUrl: string | null;
  issueType: string | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<TargetPreflight> {
  const checkedAt = new Date().toISOString();
  const issueType = input.issueType ?? "";
  const base = { issueType, targetUrl: input.targetUrl, checkedAt };
  if (!PAGE_LEVEL_ISSUES.has(issueType)) {
    return { ...base, supported: false, deliverable: null, contentTags: [], presentTags: [], reason: "Issue does not require a page-content embed." };
  }
  if (!input.targetUrl) {
    return { ...base, supported: true, deliverable: false, contentTags: [], presentTags: [], reason: "Action has no target URL." };
  }

  const targets = await db.deliveryTarget.findMany({
    where: {
      siteId: input.siteId,
      enabled: true,
      adapter: "wix_embed",
      componentTag: { not: null },
    },
    select: { componentTag: true },
  });
  const contentTags = contentEmbedTags(targets);
  if (contentTags.length === 0) {
    return {
      ...base,
      supported: true,
      deliverable: false,
      contentTags,
      presentTags: [],
      reason: "No page-content embed is mapped for this site; a code-only page fix cannot render.",
    };
  }

  try {
    const response = await (input.fetchImpl ?? fetch)(input.targetUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": LIVE_UA,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return {
        ...base,
        supported: true,
        deliverable: false,
        contentTags,
        presentTags: [],
        reason: `Could not verify a content embed on the target page (HTTP ${response.status}).`,
      };
    }
    const presentTags = presentContentTags(await response.text(), contentTags);
    return {
      ...base,
      supported: true,
      deliverable: presentTags.length > 0,
      contentTags,
      presentTags,
      reason: presentTags.length > 0
        ? `Content embed present: ${presentTags.join(", ")}.`
        : `No page-content embed found on the target page. Mapped content tags: ${contentTags.slice(0, 8).join(", ")}.`,
    };
  } catch (error) {
    return {
      ...base,
      supported: true,
      deliverable: false,
      contentTags,
      presentTags: [],
      reason: `Could not verify a content embed on the target page: ${error instanceof Error ? error.message.slice(0, 160) : "request failed"}.`,
    };
  }
}
