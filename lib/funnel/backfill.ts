import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord, type EvidenceDb, type MetricValue } from "@/lib/funnel/evidence";
import { runDetectors } from "@/lib/funnel/detectors";
import { discoverClusters } from "@/lib/funnel/cluster-discovery";
import type { OpportunityDb } from "@/lib/funnel/opportunity";

/**
 * Evidence backfill (docs/seo-funnel-spine-plan.md §6 cutover).
 *
 * The funnel starts clean, but "clean" does not mean empty: detectors backfill
 * opportunities from stored evidence that is already usable. This module
 * projects existing first-party data (our crawler, Search Console) into the
 * typed EvidenceRecord envelope so the funnel has real inputs before the
 * DataForSEO adapters (DS-04/05/06) land.
 *
 * Reads only. No paid calls, no mutation of legacy tables.
 */

export type BackfillDb = EvidenceDb &
  Pick<PrismaClient, "site" | "crawl" | "crawlIssue" | "auditPage" | "keyword" | "evidenceRecord">;

export type BackfillResult = {
  projectId: string | null;
  crawlEvidence: number;
  rankEvidence: number;
  skipped: string[];
};

/** Crawl issue types that describe a technical defect with user/crawl impact. */
const CRAWLABILITY_ISSUES = new Set([
  "MISSING_TITLE",
  "DUPLICATE_TITLE",
  "MISSING_DESCRIPTION",
  "DUPLICATE_DESCRIPTION",
  "MISSING_H1",
  "MULTIPLE_H1",
  "MISSING_CANONICAL",
  "MISSING_SITEMAP",
  "BROKEN_LINK",
  "SLOW_PAGE",
  "SERVER_ERROR",
  "REDIRECT_CHAIN",
]);

/** Issue types that describe missing/mismatched structured data. */
const SCHEMA_ISSUES = new Set(["MISSING_SCHEMA", "INVALID_SCHEMA"]);

export async function backfillSiteEvidence(
  db: BackfillDb,
  siteId: string,
  opts: { projectId: string; maxKeywords?: number } = { projectId: "" }
): Promise<BackfillResult> {
  const result: BackfillResult = { projectId: opts.projectId || null, crawlEvidence: 0, rankEvidence: 0, skipped: [] };

  const crawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, finishedAt: true },
  });
  if (!crawl || !crawl.finishedAt) {
    result.skipped.push("no completed crawl");
  } else {
    const issues = await db.crawlIssue.findMany({
      where: { crawlId: crawl.id },
      select: { url: true, type: true, severity: true, message: true },
    });
    const issuesByUrl = new Map<string, typeof issues>();
    for (const issue of issues) {
      issuesByUrl.set(issue.url, [...(issuesByUrl.get(issue.url) ?? []), issue]);
    }
    const pages = await db.auditPage.findMany({
      where: { crawlId: crawl.id },
      select: { url: true, hasSchema: true, statusCode: true, responseTimeMs: true, h1Count: true },
    });

    // One evidence record per (page, issue): an opportunity must be able to
    // cite the exact observation that produced it, so a title can never say
    // "structured data" while its reason cites a duplicate title.
    for (const page of pages) {
      const pageIssues = issuesByUrl.get(page.url) ?? [];
      const reported = pageIssues.filter((issue) => CRAWLABILITY_ISSUES.has(issue.type) || SCHEMA_ISSUES.has(issue.type));

      for (const issue of reported) {
        const isSchema = SCHEMA_ISSUES.has(issue.type);
        await storeEvidenceRecord(db, {
          projectId: opts.projectId,
          siteId,
          kind: "onpage_crawl",
          observedAt: crawl.finishedAt,
          producer: "crawler",
          dimensions: {
            url: page.url,
            statusCode: page.statusCode,
            issueType: issue.type,
            severity: issue.severity,
            impact: isSchema ? "structured_data" : "crawlability",
            schemaMissing: isSchema ? "true" : null,
            schemaType: isSchema ? "LocalBusiness" : null,
          },
          metrics: {
            "first_party:issueCount": { value: 1, unit: "count", source: "first_party" },
            "first_party:responseTimeMs": { value: page.responseTimeMs, unit: "ms", source: "first_party" },
          },
        });
        result.crawlEvidence += 1;
      }

      // A page with no schema and no reported schema issue is still a gap the
      // funnel should see: record it explicitly rather than inferring later.
      if (!page.hasSchema && !reported.some((issue) => SCHEMA_ISSUES.has(issue.type))) {
        await storeEvidenceRecord(db, {
          projectId: opts.projectId,
          siteId,
          kind: "onpage_crawl",
          observedAt: crawl.finishedAt,
          producer: "crawler",
          dimensions: {
            url: page.url,
            statusCode: page.statusCode,
            issueType: "MISSING_SCHEMA",
            impact: "structured_data",
            schemaMissing: "true",
            schemaType: "LocalBusiness",
          },
          metrics: {
            "first_party:issueCount": { value: 1, unit: "count", source: "first_party" },
          },
        });
        result.crawlEvidence += 1;
      }
    }
  }

  // Search Console ranks: latest observation per (query, page).
  const keywords = await db.keyword.findMany({
    where: { siteId },
    orderBy: { date: "desc" },
    take: opts.maxKeywords ?? 400,
    select: { query: true, page: true, position: true, clicks: true, impressions: true, ctr: true, date: true },
  });
  const latest = new Map<string, (typeof keywords)[number]>();
  for (const row of keywords) {
    const key = `${row.query}|${row.page}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  for (const row of latest.values()) {
    if (!row.query || row.position <= 0) continue;
    await storeEvidenceRecord(db, {
      projectId: opts.projectId,
      siteId,
      kind: "keyword_rank",
      observedAt: row.date,
      producer: "search_console",
      dimensions: { query: row.query, url: row.page || null },
      metrics: {
        "first_party:position": { value: row.position, unit: "rank", source: "first_party" },
        "first_party:clicks": { value: row.clicks, unit: "count", source: "first_party" },
        "first_party:impressions": { value: row.impressions, unit: "count", source: "first_party" },
        "first_party:ctr": { value: row.ctr, unit: "ratio", source: "first_party" },
      },
    });
    result.rankEvidence += 1;
  }
  if (latest.size === 0) result.skipped.push("no search console rows");

  return result;
}

export type RefreshDb = BackfillDb & OpportunityDb & Pick<PrismaClient, "demandMapCluster" | "keyword">;

/**
 * Refresh the funnel for one site: backfill evidence from first-party stores,
 * then run every detector. Idempotent (evidence upserts by observation hash,
 * opportunities dedupe by key). Reads only; makes no paid calls.
 */
export async function refreshFunnelForSite(
  db: RefreshDb,
  siteId: string,
  opts: { detectedBy?: string } = {}
): Promise<BackfillResult & { created: number; updated: number; parked: number }> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true, domain: true } });
  if (!site?.projectId) {
    return {
      projectId: null,
      crawlEvidence: 0,
      rankEvidence: 0,
      skipped: ["site is not attached to a project"],
      created: 0,
      updated: 0,
      parked: 0,
    };
  }
  const backfill = await backfillSiteEvidence(db, siteId, { projectId: site.projectId });
  // Clusters first: a discovered cluster lets the board group work by need and
  // lets the cluster play fire in the same run.
  await discoverClusters(db, site.projectId, { siteId });
  const detection = await runDetectors(db, site.projectId, { detectedBy: opts.detectedBy ?? "funnel-refresh" });
  return { ...backfill, created: detection.created, updated: detection.updated, parked: detection.parked.length };
}
