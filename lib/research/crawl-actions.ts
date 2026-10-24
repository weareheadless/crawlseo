import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { REMEDIATION } from "@/lib/crawler/remediation";
import { createResearchAction } from "@/lib/research/service";

type CrawlIssueRow = {
  url: string;
  type: string;
  severity: string;
  message: string;
  details: unknown;
};

type AuditPageRow = {
  url: string;
  title: string | null;
  description: string | null;
  wordCount: number;
  contentScore: number;
  h1Count: number;
  statusCode: number;
};

type CrawlActionSite = { domain: string };

type CrawlActionCrawl = { id: string; pagesFound: number };

export type CrawlActionDraft = {
  dedupeKey: string;
  title: string;
  targetUrl: string;
  recommendation: string;
  priority: number;
  issueType: string;
  severity: string;
  groupKey: string;
  groupLabel: string;
  affectedPages: number;
  evidence: Record<string, unknown>;
};

type IssueGroup = {
  key: string;
  label: string;
  type: string;
  severity: string;
  urls: Set<string>;
  statusCodes: Set<number>;
  occurrences: number;
  sampleUrl: string;
  orphan: boolean;
};

const SITE_WIDE_ISSUES = new Set(["MISSING_ROBOTS", "MISSING_SITEMAP"]);
const EXCLUDED_DETAIL_KINDS = new Set(["crawl_summary", "content_score"]);
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function validUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function duplicateUrls(issue: CrawlIssueRow): string[] {
  const values = record(issue.details).urls;
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string" && validUrl(value))
    : [];
}

function brokenStatusCode(issue: CrawlIssueRow): number | null {
  const details = record(issue.details);
  const fromDetails = Number(details.statusCode);
  if (Number.isFinite(fromDetails) && fromDetails >= 400) return fromDetails;
  const fromMessage = Number(issue.message.match(/\b([45]\d{2})\b/)?.[1]);
  return Number.isFinite(fromMessage) ? fromMessage : null;
}

function pathFamily(url: string): { key: string; label: string } {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  if (path === "/" || path === "") return { key: "home", label: "homepage" };
  const segments = path.split("/").filter(Boolean);
  const first = segments[0] ?? "";
  if (first === "post") return { key: "blog-post", label: "blog post template" };
  if (first === "blog") return { key: "blog", label: "blog template" };
  if (first === "real-estate-listings" || first === "listings" || first === "properties") {
    return { key: "listing", label: "listing template" };
  }
  if (first === "profile" || first === "my-account") return { key: "profile", label: "profile template" };
  if (["category", "categories", "collections", "collection"].includes(first)) {
    return { key: "category", label: "category template" };
  }
  if (first === "product-page" || first === "product" || first === "products") {
    return { key: "product", label: "product template" };
  }
  if (segments.length === 1) return { key: "landing", label: "landing pages" };
  return { key: first, label: `${first.replace(/[-_]+/g, " ")} pages` };
}

function groupForIssue(issue: CrawlIssueRow): { key: string; label: string } | null {
  const details = record(issue.details);
  if (EXCLUDED_DETAIL_KINDS.has(String(details.kind ?? ""))) return null;
  if (!validUrl(issue.url)) return null;

  if (issue.type === "DUPLICATE_TITLE" || issue.type === "DUPLICATE_DESCRIPTION") {
    const urls = duplicateUrls(issue);
    if (urls.length === 0) return null;
    const signature = createHash("sha256").update([...urls].sort().join("|")).digest("hex").slice(0, 16);
    const family = pathFamily(urls[0]);
    return { key: `duplicate:${signature}`, label: family.label };
  }
  if (SITE_WIDE_ISSUES.has(issue.type)) {
    return { key: "site", label: "site-wide" };
  }
  if (issue.type === "BROKEN_LINK") {
    const status = brokenStatusCode(issue);
    const family = pathFamily(issue.url);
    return {
      key: status ? `broken:${status}:${family.key}` : `broken:${family.key}`,
      label: status ? `${family.label} · HTTP ${status}` : family.label,
    };
  }
  const family = pathFamily(issue.url);
  return { key: family.key, label: family.label };
}

function actionPriority(severity: string, affectedPct: number, statusCode: number | null): number {
  if (statusCode === 429) return 35;
  const base = severity === "CRITICAL" ? 82 : severity === "WARNING" ? 62 : 40;
  return Math.min(100, Math.round(base + Math.min(12, affectedPct / 8)));
}

function pageEvidence(page: AuditPageRow | undefined): Record<string, unknown> | null {
  if (!page) return null;
  return {
    url: page.url,
    title: page.title ?? "",
    description: page.description ?? "",
    wordCount: page.wordCount,
    contentScore: page.contentScore,
    h1Count: page.h1Count,
    statusCode: page.statusCode,
  };
}

export function buildCrawlActionDrafts(input: {
  site: CrawlActionSite;
  crawl: CrawlActionCrawl;
  issues: CrawlIssueRow[];
  pages: AuditPageRow[];
}): CrawlActionDraft[] {
  const pagesByUrl = new Map(input.pages.map((page) => [page.url, page]));
  const groups = new Map<string, IssueGroup>();

  for (const issue of input.issues) {
    const group = groupForIssue(issue);
    if (!group) continue;
    const orphan = issue.type === "MISSING_CANONICAL" && record(issue.details).kind === "orphan";
    const urls = issue.type === "DUPLICATE_TITLE" || issue.type === "DUPLICATE_DESCRIPTION"
      ? duplicateUrls(issue)
      : [issue.url];
    if (urls.length === 0) continue;
    const key = `${issue.type}:${group.key}`;
    const existing = groups.get(key);
    if (existing) {
      for (const url of urls) existing.urls.add(url);
      existing.occurrences += 1;
      existing.orphan = existing.orphan || orphan;
      if ((SEVERITY_RANK[issue.severity] ?? 3) < (SEVERITY_RANK[existing.severity] ?? 3)) {
        existing.severity = issue.severity;
      }
      const status = brokenStatusCode(issue);
      if (status) existing.statusCodes.add(status);
    } else {
      const status = brokenStatusCode(issue);
      groups.set(key, {
        key,
        label: group.label,
        type: issue.type,
        severity: issue.severity,
        urls: new Set(urls),
        statusCodes: new Set(status ? [status] : []),
        occurrences: 1,
        sampleUrl: urls[0],
        orphan,
      });
    }
  }

  const drafts: CrawlActionDraft[] = [];
  for (const group of groups.values()) {
    const urls = [...group.urls].filter(validUrl);
    if (urls.length === 0) continue;
    const representative = urls.find((url) => pagesByUrl.get(url)?.statusCode === 200) ?? urls[0];
    const affectedPages = urls.length;
    const affectedPct = Math.round((affectedPages / Math.max(1, input.crawl.pagesFound)) * 1000) / 10;
    const statusCode = group.statusCodes.size === 1 ? [...group.statusCodes][0] : null;
    const severity = statusCode === 429 ? "INFO" : group.severity;
    const remediation = REMEDIATION[group.type];
    const issueTitle = group.orphan
      ? "Orphaned page"
      : remediation?.title ?? group.type.replaceAll("_", " ").toLowerCase();
    const title = SITE_WIDE_ISSUES.has(group.type)
      ? `${issueTitle} — ${affectedPages} page${affectedPages === 1 ? "" : "s"}`
      : `${issueTitle} — ${group.label} (${affectedPages} page${affectedPages === 1 ? "" : "s"})`;
    const fix = group.orphan
      ? "Add internal links from relevant pages to this orphan page, or remove or redirect it if it should not be indexed."
      : remediation?.howToFix ?? "Review the affected pages and fix the underlying template or content issue.";
    const rateLimit = statusCode === 429
      ? "The crawler received HTTP 429 on these URLs. Confirm manually before changing content; this may be crawl throttling rather than a broken page."
      : "";
    const scope = group.orphan
      ? `This affects ${affectedPages} orphaned page${affectedPages === 1 ? "" : "s"} with no internal inlinks. Add contextual internal links from relevant pages, or remove/redirect the page.`
      : SITE_WIDE_ISSUES.has(group.type)
        ? `This is a site-wide issue affecting ${affectedPages} crawled page${affectedPages === 1 ? "" : "s"}.`
        : `This affects ${affectedPages} crawled page${affectedPages === 1 ? "" : "s"} in the ${group.label} group. Fix the shared template or component where possible, then verify sibling routes remain unchanged.`;
    const recommendation = [fix, rateLimit, scope].filter(Boolean).join("\n\n").slice(0, 4_000);
    const page = pageEvidence(pagesByUrl.get(representative));
    const evidence = {
      kind: "crawl_issue",
      technical: true,
      crawl_id: input.crawl.id,
      issue_type: group.orphan ? "ORPHAN_PAGE" : group.type,
      issue_group: group.key,
      group_label: group.label,
      severity,
      crawl_severity: group.severity,
      affected_pages: affectedPages,
      affected_pct: affectedPct,
      occurrences: group.occurrences,
      status_codes: [...group.statusCodes],
      sample_url: representative,
      urls: urls.slice(0, 20),
      how_to_fix: fix,
      ...(page ? { page } : {}),
    };
    drafts.push({
      dedupeKey: `crawl:${group.key}`,
      title: title.slice(0, 240),
      targetUrl: representative,
      recommendation,
      priority: actionPriority(severity, affectedPct, statusCode),
      issueType: group.type,
      severity,
      groupKey: group.key,
      groupLabel: group.label,
      affectedPages,
      evidence,
    });
  }

  return drafts.sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));
}

export async function syncCrawlIssuesToActions(siteId: string) {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { domain: true },
  });
  if (!site) return { created: 0, updated: 0, dismissed: 0, existing: 0, total: 0 };
  const crawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, pagesFound: true },
  });
  if (!crawl) return { created: 0, updated: 0, dismissed: 0, existing: 0, total: 0, crawlId: null };

  const [issues, pages, current] = await Promise.all([
    db.crawlIssue.findMany({
      where: { crawlId: crawl.id },
      select: { url: true, type: true, severity: true, message: true, details: true },
    }),
    db.auditPage.findMany({
      where: { crawlId: crawl.id },
      select: {
        url: true,
        title: true,
        description: true,
        wordCount: true,
        contentScore: true,
        h1Count: true,
        statusCode: true,
      },
    }),
    db.researchAction.findMany({
      where: { siteId, source: "crawl_issue" },
      select: { id: true, status: true, priority: true, dedupeKey: true },
    }),
  ]);

  const drafts = buildCrawlActionDrafts({ site, crawl, issues, pages });
  const byKey = new Map(current.map((action) => [action.dedupeKey, action]));
  let created = 0;
  let updated = 0;
  let existing = 0;

  for (const draft of drafts) {
    const previous = byKey.get(draft.dedupeKey);
    if (previous && ["DISMISSED", "VERIFIED", "FAILED"].includes(previous.status)) {
      existing += 1;
      continue;
    }
    if (previous) {
      await db.researchAction.update({
        where: { id: previous.id },
        data: {
          kind: "fix_technical_issue",
          format: "page_update",
          title: draft.title,
          targetUrl: draft.targetUrl,
          recommendation: draft.recommendation,
          priority: Math.max(previous.priority, draft.priority),
          evidence: json(draft.evidence),
        },
      });
      updated += 1;
      continue;
    }
    const result = await createResearchAction(
      siteId,
      {
        source: "crawl_issue",
        kind: "fix_technical_issue",
        format: "page_update",
        title: draft.title,
        targetUrl: draft.targetUrl,
        recommendation: draft.recommendation,
        priority: draft.priority,
        automationMode: "MANUAL",
        dedupeKey: draft.dedupeKey,
        evidence: draft.evidence,
      },
      "crawl-actions",
    );
    if (result.created) created += 1;
    else existing += 1;
  }

  return {
    created,
    updated,
    dismissed: 0,
    existing,
    total: drafts.length,
    crawlId: crawl.id,
    issues: issues.length,
    groups: drafts.length,
  };
}
