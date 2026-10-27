import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { REMEDIATION } from "@/lib/crawler/remediation";
import { createResearchAction } from "@/lib/research/service";
import { isWixBlogTarget } from "@/lib/agent-tasks/targets";
import { verifyCrawlDraftLive } from "@/lib/research/crawl-live-check";

type CrawlIssueRow = {
  url: string;
  type: string;
  severity: string;
  message: string;
  details: unknown;
};

type AuditLinkRow = {
  sourceUrl: string;
  targetUrl: string;
  anchorText: string | null;
  statusCode: number | null;
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

type CrawlActionCrawl = { id: string; pagesFound: number; finishedAt?: Date | null };

export type CrawlActionDraft = {
  dedupeKey: string;
  title: string;
  targetUrl: string;
  recommendation: string;
  priority: number;
  issueType: string;
  kind: "fix_technical_issue" | "fix_broken_link";
  fixMode: "site_code" | "blog_content";
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
  duplicateValue: string | null;
  sourceUrl: string | null;
  brokenUrls: Set<string>;
  anchors: Set<string>;
  batch: boolean;
  families: Set<string>;
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
  if (first === "blog") {
    if (segments.length === 1) return { key: "blog-index", label: "blog index" };
    if (segments[1] === "tags") return { key: "blog-tag", label: "blog tag template" };
    if (segments[1] === "categories") return { key: "blog-category", label: "blog category template" };
    return { key: "blog", label: "blog template" };
  }
  if (first === "real-estate-listings" || first === "listings" || first === "properties") {
    return segments.length === 1
      ? { key: "listing-index", label: "listing index" }
      : { key: "listing-detail", label: "listing detail template" };
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

function groupForIssue(issue: CrawlIssueRow, linksByTarget: Map<string, AuditLinkRow[]>): { key: string; label: string } | null {
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
    const source = linksByTarget.get(issue.url)?.[0]?.sourceUrl;
    const family = pathFamily(source ?? issue.url);
    if (source) {
      const signature = createHash("sha256").update(source).digest("hex").slice(0, 16);
      return {
        key: `broken:${status ?? "unknown"}:source:${signature}`,
        label: `${family.label} source`,
      };
    }
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
  links?: AuditLinkRow[];
}): CrawlActionDraft[] {
  const pagesByUrl = new Map(input.pages.map((page) => [page.url, page]));
  const linksByTarget = new Map<string, AuditLinkRow[]>();
  for (const link of input.links ?? []) {
    const list = linksByTarget.get(link.targetUrl) ?? [];
    list.push(link);
    linksByTarget.set(link.targetUrl, list);
  }
  const groups = new Map<string, IssueGroup>();

  for (const issue of input.issues) {
    const details = record(issue.details);
    if (EXCLUDED_DETAIL_KINDS.has(String(details.kind ?? ""))) continue;
    if (!validUrl(issue.url)) continue;
    if (issue.type !== "BROKEN_LINK" && (pagesByUrl.get(issue.url)?.statusCode ?? 200) >= 400) continue;
    const sourceLinks = issue.type === "BROKEN_LINK" ? linksByTarget.get(issue.url) ?? [] : [];
    const sourceUrl = sourceLinks[0]?.sourceUrl ?? null;
    const blogContentIssue = issue.type === "BROKEN_LINK" && Boolean(sourceUrl) && isWixBlogTarget(sourceUrl!);
    const batch = !blogContentIssue
      && !SITE_WIDE_ISSUES.has(issue.type)
      && !["BROKEN_LINK", "DUPLICATE_TITLE", "DUPLICATE_DESCRIPTION"].includes(issue.type);
    const group = batch
      ? { key: "all-pages", label: "all affected pages" }
      : groupForIssue(issue, linksByTarget);
    if (!group) continue;
    const orphan = issue.type === "MISSING_CANONICAL" && record(issue.details).kind === "orphan";
    const detailsRecord = record(issue.details);
    const duplicateValue = issue.type === "DUPLICATE_TITLE"
      ? (typeof detailsRecord.title === "string" ? detailsRecord.title : null)
      : issue.type === "DUPLICATE_DESCRIPTION"
        ? (typeof detailsRecord.description === "string" ? detailsRecord.description : null)
        : null;
    const family = pathFamily(sourceUrl ?? issue.url).label;
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
      if (!existing.duplicateValue && duplicateValue) existing.duplicateValue = duplicateValue;
      if ((SEVERITY_RANK[issue.severity] ?? 3) < (SEVERITY_RANK[existing.severity] ?? 3)) {
        existing.severity = issue.severity;
      }
      const status = brokenStatusCode(issue);
      if (status) existing.statusCodes.add(status);
      if (!existing.sourceUrl && sourceUrl) existing.sourceUrl = sourceUrl;
      if (issue.type === "BROKEN_LINK") existing.brokenUrls.add(issue.url);
      existing.families.add(family);
      for (const link of sourceLinks) {
        if (link.anchorText) existing.anchors.add(link.anchorText);
      }
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
        duplicateValue,
        sourceUrl,
        brokenUrls: new Set(issue.type === "BROKEN_LINK" ? [issue.url] : []),
        anchors: new Set(sourceLinks.map((link) => link.anchorText).filter((value): value is string => Boolean(value))),
        batch,
        families: new Set([family]),
      });
    }
  }

  const drafts: CrawlActionDraft[] = [];
  for (const group of groups.values()) {
    const urls = [...group.urls].filter(validUrl);
    if (urls.length === 0) continue;
    const representative = urls.find((url) => pagesByUrl.get(url)?.statusCode === 200) ?? urls[0];
    const targetUrl = group.sourceUrl ?? representative;
    const statusCode = group.statusCodes.size === 1 ? [...group.statusCodes][0] : null;
    const blogContent = group.type === "BROKEN_LINK" && isWixBlogTarget(targetUrl);
    const kind = blogContent ? "fix_broken_link" : "fix_technical_issue";
    const fixMode = blogContent ? "blog_content" : "site_code";
    const affectedPages = group.type === "BROKEN_LINK" && group.brokenUrls.size > 0 ? group.brokenUrls.size : urls.length;
    const affectedPct = Math.round((affectedPages / Math.max(1, input.crawl.pagesFound)) * 1000) / 10;
    const severity = statusCode === 429 ? "INFO" : group.severity;
    const remediation = REMEDIATION[group.type];
    const issueTitle = group.orphan
      ? "Orphaned page"
      : remediation?.title ?? group.type.replaceAll("_", " ").toLowerCase();
    const title = group.type === "BROKEN_LINK" && group.sourceUrl
      ? `Broken links in ${group.label.replace(/ source$/, "")} (${affectedPages} link${affectedPages === 1 ? "" : "s"})`
      : group.batch
        ? `${issueTitle} — ${affectedPages} pages across ${group.families.size} template${group.families.size === 1 ? "" : "s"}`
        : SITE_WIDE_ISSUES.has(group.type)
          ? `${issueTitle} — ${affectedPages} page${affectedPages === 1 ? "" : "s"}`
          : `${issueTitle} — ${group.label} (${affectedPages} page${affectedPages === 1 ? "" : "s"})`;
    const fix = group.orphan
      ? "Add internal links from relevant pages to this orphan page, or remove or redirect it if it should not be indexed."
      : remediation?.howToFix ?? "Review the affected pages and fix the underlying template or content issue.";
    const rateLimit = statusCode === 429
      ? "The crawler received HTTP 429 on these URLs. Confirm manually before changing content; this may be crawl throttling rather than a broken page."
      : "";
    const scope = group.type === "BROKEN_LINK" && group.sourceUrl
      ? `The broken URLs are linked from ${group.sourceUrl}: ${[...group.brokenUrls].join(", ")}.${group.anchors.size ? ` Anchor text: ${[...group.anchors].join(", ")}.` : ""} ${blogContent ? "Update the Wix Blog post content to remove or correct these links. This is a content update, not a repo code change." : "Update the source page content to remove or correct these links."}`
      : group.orphan
        ? `This affects ${affectedPages} orphaned page${affectedPages === 1 ? "" : "s"} with no internal inlinks. Add contextual internal links from relevant pages, or remove/redirect the page.`
        : group.batch
          ? `This affects ${affectedPages} pages across ${group.families.size} template${group.families.size === 1 ? "" : "s"}: ${[...group.families].join(", ")}. Fix every affected template, not just the target URL. Verify sibling routes remain unchanged.`
          : SITE_WIDE_ISSUES.has(group.type)
            ? `This is a site-wide issue affecting ${affectedPages} crawled page${affectedPages === 1 ? "" : "s"}.`
            : `This affects ${affectedPages} crawled page${affectedPages === 1 ? "" : "s"} in the ${group.label} group. Fix the shared template or component where possible, then verify sibling routes remain unchanged.`;
    const crawlDate = input.crawl.finishedAt
      ? new Date(input.crawl.finishedAt).toISOString().slice(0, 10)
      : null;
    const recommendation = [crawlDate ? `Crawl evidence from ${crawlDate}.` : "", fix, rateLimit, scope]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4_000);
    const page = pageEvidence(pagesByUrl.get(targetUrl));
    const evidence = {
      kind: "crawl_issue",
      technical: fixMode === "site_code",
      crawl_id: input.crawl.id,
      crawl_finished_at: input.crawl.finishedAt ? new Date(input.crawl.finishedAt).toISOString() : null,
      issue_type: group.orphan ? "ORPHAN_PAGE" : group.type,
      duplicate_value: group.duplicateValue,
      examples: urls.slice(0, 5).map((url) => {
        const page = pagesByUrl.get(url);
        return {
          url,
          title: page?.title ?? null,
          description: page?.description ?? null,
          statusCode: page?.statusCode ?? null,
          h1Count: page?.h1Count ?? null,
        };
      }),
      fix_mode: fixMode,
      batch: group.batch,
      route_families: [...group.families],
      issue_group: group.key,
      group_label: group.label,
      severity,
      crawl_severity: group.severity,
      affected_pages: affectedPages,
      affected_pct: affectedPct,
      occurrences: group.occurrences,
      status_codes: [...group.statusCodes],
      sample_url: targetUrl,
      urls: urls.slice(0, group.batch ? 100 : 20),
      source_url: group.sourceUrl,
      broken_urls: [...group.brokenUrls],
      anchor_texts: [...group.anchors],
      how_to_fix: fix,
      ...(page ? { page } : {}),
    };
    drafts.push({
      dedupeKey: `crawl:${group.key}`,
      title: title.slice(0, 240),
      targetUrl,
      recommendation,
      priority: actionPriority(severity, affectedPct, statusCode),
      issueType: group.type,
      kind,
      fixMode,
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
    select: { id: true, pagesFound: true, finishedAt: true },
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
      select: { id: true, status: true, priority: true, dedupeKey: true, evidence: true },
    }),
  ]);

  const brokenTargets = issues
    .filter((issue) => issue.type === "BROKEN_LINK")
    .map((issue) => issue.url);
  const links = brokenTargets.length > 0
    ? await db.auditLink.findMany({
        where: { crawlId: crawl.id, targetUrl: { in: brokenTargets } },
        select: { sourceUrl: true, targetUrl: true, anchorText: true, statusCode: true },
      })
    : [];

  const drafts = buildCrawlActionDrafts({ site, crawl, issues, pages, links });
  const byKey = new Map(current.map((action) => [action.dedupeKey, action]));
  let created = 0;
  let updated = 0;
  let existing = 0;
  let liveResolved = 0;

  for (const draft of drafts) {
    const previous = byKey.get(draft.dedupeKey);
    const previousEvidence = previous ? record(previous.evidence) : {};
    const canReactivate = previous?.status === "DISMISSED" && previousEvidence.superseded === true;
    if (previous && ["DISMISSED", "VERIFIED", "FULFILLED", "FAILED"].includes(previous.status) && !canReactivate) {
      existing += 1;
      continue;
    }
    const liveCheck = await verifyCrawlDraftLive(draft);
    if (liveCheck?.reproduced_url) {
      draft.targetUrl = liveCheck.reproduced_url;
      draft.evidence = { ...draft.evidence, sample_url: liveCheck.reproduced_url };
    }
    const evidence = liveCheck ? { ...draft.evidence, live_check: liveCheck } : draft.evidence;
    if (liveCheck?.issue_reproduced === false) {
      if (previous) {
        const previousEvidence = record(previous.evidence);
        await db.researchAction.update({
          where: { id: previous.id },
          data: {
            status: "DISMISSED",
            evidence: json({
              ...previousEvidence,
              ...evidence,
              superseded: true,
              superseded_reason: `Live check found the issue no longer reproduces (H1 count ${liveCheck.h1_count ?? "unknown"}).`,
            }),
          },
        });
      }
      liveResolved += 1;
      continue;
    }
    if (previous) {
      await db.researchAction.update({
        where: { id: previous.id },
        data: {
          ...(canReactivate ? { status: "PROPOSED" } : {}),
          kind: draft.kind,
          format: "page_update",
          title: draft.title,
          targetUrl: draft.targetUrl,
          recommendation: draft.recommendation,
          priority: Math.max(previous.priority, draft.priority),
          evidence: json(evidence),
        },
      });
      updated += 1;
      continue;
    }
    const result = await createResearchAction(
      siteId,
      {
        source: "crawl_issue",
        kind: draft.kind,
        format: "page_update",
        title: draft.title,
        targetUrl: draft.targetUrl,
        recommendation: draft.recommendation,
        priority: draft.priority,
        automationMode: "MANUAL",
        dedupeKey: draft.dedupeKey,
        evidence,
      },
      "crawl-actions",
    );
    if (result.created) created += 1;
    else existing += 1;
  }

  const draftKeys = new Set(drafts.map((draft) => draft.dedupeKey));
  let staleDismissed = 0;
  for (const action of current) {
    if (draftKeys.has(action.dedupeKey) || action.status !== "PROPOSED") continue;
    const evidence = record(action.evidence);
    await db.researchAction.update({
      where: { id: action.id },
      data: {
        status: "DISMISSED",
        evidence: json({
          ...evidence,
          superseded: true,
          superseded_reason: "Crawl grouping changed to a more specific route-family action.",
        }),
      },
    });
    staleDismissed += 1;
  }

  return {
    created,
    updated,
    dismissed: staleDismissed,
    liveResolved,
    existing,
    total: drafts.length,
    crawlId: crawl.id,
    issues: issues.length,
    groups: drafts.length,
  };
}
