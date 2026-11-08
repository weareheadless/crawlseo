import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord, type EvidenceDb } from "@/lib/funnel/evidence";
import { currentPerformanceWindow, readPagePerformance, readQueryPagePerformance } from "@/lib/funnel/gsc-performance";
import { previousWindow } from "@/lib/funnel/performance-window";
import { bridgeBusinessKnowledgeToEvidence } from "@/lib/projects/business-knowledge-evidence";
import { bridgeQuestionCoverageToEvidence } from "@/lib/research/question-coverage-evidence";
import { brandTermsFromDomain, runDetectors } from "@/lib/funnel/detectors";
import { discoverClusters } from "@/lib/funnel/cluster-discovery";
import { reassessLegacyFindings } from "@/lib/research/reassess-findings";
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
  Pick<PrismaClient, "site" | "crawl" | "crawlIssue" | "auditPage" | "keyword" | "page" | "evidenceRecord" | "$queryRaw">;

export type BackfillResult = {
  projectId: string | null;
  crawlEvidence: number;
  rankEvidence: number;
  /** Page-level Search Console observations (the honest page demand signal). */
  pageEvidence: number;
  /** The window every performance observation covers, when there was data. */
  window: { start: string; end: string; days: number } | null;
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

/**
 * Whether a MISSING_SCHEMA issue is actually about missing markup.
 *
 * `MISSING_SCHEMA` is a catch-all in the crawler: business-consistency audits that
 * could not run, sitemap coverage gaps, AI-crawler blocks and the crawl summary are
 * all stored under it. Counting every one as "no structured data" inflated a board
 * from 127 pages without schema to 513 — 500 of them being "business knowledge
 * unavailable", which is a missing input, not a missing tag.
 */
export function isSchemaAbsence(issue: { type: string; details?: unknown }): boolean {
  if (!SCHEMA_ISSUES.has(issue.type)) return false;
  const kind = (issue.details as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string") return true; // legacy rows without details
  return kind === "identity_jsonld_absence" || kind === "schema_absence";
}

/**
 * Issues that describe an HTTP response rather than page content. They stay valid
 * even when the page itself could not be assessed.
 */
const RESPONSE_ISSUES = new Set(["BROKEN_LINK", "SERVER_ERROR", "REDIRECT_CHAIN", "SLOW_PAGE"]);

const CHALLENGE_TITLE = /checking your (request|browser)|just a moment|access denied|attention required|captcha/i;

/** Whether the crawler actually saw the page, rather than a challenge or an error. */
export function isAssessedPage(page: { statusCode: number; title?: string | null }): boolean {
  if (page.statusCode !== 200) return false;
  return !(page.title && CHALLENGE_TITLE.test(page.title));
}

/** The structured-data type the page was expected to carry, when the crawl said. */
function schemaTypeOf(issue: { details?: unknown }): string | null {
  const value = (issue.details as { schemaType?: unknown } | null)?.schemaType;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function backfillSiteEvidence(
  db: BackfillDb,
  siteId: string,
  opts: { projectId: string; maxKeywords?: number } = { projectId: "" }
): Promise<BackfillResult> {
  const result: BackfillResult = { projectId: opts.projectId || null, crawlEvidence: 0, rankEvidence: 0, pageEvidence: 0, window: null, skipped: [] };

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
      select: { url: true, type: true, severity: true, message: true, details: true },
    });
    const issuesByUrl = new Map<string, typeof issues>();
    for (const issue of issues) {
      issuesByUrl.set(issue.url, [...(issuesByUrl.get(issue.url) ?? []), issue]);
    }
    const pages = await db.auditPage.findMany({
      where: { crawlId: crawl.id },
      select: { url: true, title: true, hasSchema: true, statusCode: true, responseTimeMs: true, h1Count: true },
    });

    // One evidence record per (page, issue): an opportunity must be able to
    // cite the exact observation that produced it, so a title can never say
    // "structured data" while its reason cites a duplicate title.
    for (const page of pages) {
      // A blocked or failed fetch observed a response, not a page. Its missing H1,
      // missing schema or thin content are unknown, and asserting them turns an
      // anti-bot challenge into a list of website defects.
      const assessed = isAssessedPage(page);
      const pageIssues = issuesByUrl.get(page.url) ?? [];
      const reported = pageIssues.filter((issue) =>
        RESPONSE_ISSUES.has(issue.type) ||
        (assessed && (
          CRAWLABILITY_ISSUES.has(issue.type) ||
          (SCHEMA_ISSUES.has(issue.type) && isSchemaAbsence(issue))
        ))
      );

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
            crawlId: crawl.id,
            statusCode: page.statusCode,
            issueType: issue.type,
            severity: issue.severity,
            impact: isSchema ? "structured_data" : "crawlability",
            schemaMissing: isSchema ? "true" : null,
            // The page's own declared type, when the crawl recorded one. Assuming
            // LocalBusiness for every page turned a blog post into a business-schema
            // defect.
            schemaType: isSchema ? schemaTypeOf(issue) : null,
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
      if (assessed && !page.hasSchema && !reported.some((issue) => SCHEMA_ISSUES.has(issue.type))) {
        await storeEvidenceRecord(db, {
          projectId: opts.projectId,
          siteId,
          kind: "onpage_crawl",
          observedAt: crawl.finishedAt,
          producer: "crawler",
          dimensions: {
            url: page.url,
            crawlId: crawl.id,
            statusCode: page.statusCode,
            issueType: "MISSING_SCHEMA",
            impact: "structured_data",
            schemaMissing: "true",
            schemaType: null,
          },
          metrics: {
            "first_party:issueCount": { value: 1, unit: "count", source: "first_party" },
          },
        });
        result.crawlEvidence += 1;
      }
    }
  }

  // Search Console performance, aggregated over an explicit window.
  //
  // The previous projection read at most 400 raw rows and kept one per query/page.
  // Those rows are split by day, device and country, so a query with 269
  // impressions over 28 days was represented by a single one-impression row, and
  // a site with 986 observed queries reached the board with 238. The window is
  // anchored to the latest day that has data: a lagging export must not read as a
  // complete window of zeroes.
  const window = await currentPerformanceWindow(db, siteId);
  if (!window) {
    result.skipped.push("no search console rows");
    return result;
  }
  result.window = { start: window.start.toISOString(), end: window.end.toISOString(), days: window.days };

  const pagePerformance = await readPagePerformance(db, siteId, window);
  for (const page of pagePerformance) {
    await storeEvidenceRecord(db, {
      projectId: opts.projectId,
      siteId,
      kind: "gsc_page",
      observedAt: window.end,
      producer: "search_console",
      dimensions: { url: page.url, windowDays: window.days, windowEnd: window.end.toISOString(), scope: "all" },
      metrics: {
        "first_party:clicks": { value: page.clicks, unit: "count", source: "first_party" },
        "first_party:impressions": { value: page.impressions, unit: "count", source: "first_party" },
        "first_party:ctr": { value: page.ctr, unit: "ratio", source: "first_party" },
        "first_party:position": { value: page.position, unit: "rank", source: "first_party" },
      },
    });
    result.pageEvidence += 1;
  }

  // Query/page performance is a separate observation from the page total: Search
  // Console query rows are privacy-limited and do not sum to the page total.
  const queryPerformance = await readQueryPagePerformance(db, siteId, window);
  for (const row of queryPerformance) {
    if (row.impressions <= 0) continue;
    await storeEvidenceRecord(db, {
      projectId: opts.projectId,
      siteId,
      kind: "keyword_rank",
      observedAt: window.end,
      producer: "search_console",
      dimensions: {
        query: row.query,
        url: row.url,
        windowDays: window.days,
        windowEnd: window.end.toISOString(),
        windowRole: "current",
        scope: "all",
        observations: row.observations,
        segments: row.segments,
      },
      metrics: {
        "first_party:position": { value: row.position, unit: "rank", source: "first_party" },
        "first_party:clicks": { value: row.clicks, unit: "count", source: "first_party" },
        "first_party:impressions": { value: row.impressions, unit: "count", source: "first_party" },
        "first_party:ctr": { value: row.ctr, unit: "ratio", source: "first_party" },
      },
    });
    result.rankEvidence += 1;
  }
  if (queryPerformance.length === 0) result.skipped.push("no search console query rows in the window");

  // The comparison window: decline and recovery cannot be stated from one window,
  // and comparing daily rows treated a normal oscillation as a trend.
  const previous = previousWindow(window);
  const previousPerformance = await readQueryPagePerformance(db, siteId, previous);
  for (const row of previousPerformance) {
    if (row.impressions <= 0) continue;
    await storeEvidenceRecord(db, {
      projectId: opts.projectId,
      siteId,
      kind: "keyword_rank",
      observedAt: previous.end,
      producer: "search_console",
      dimensions: {
        query: row.query,
        url: row.url,
        windowDays: previous.days,
        windowEnd: previous.end.toISOString(),
        windowRole: "previous",
        scope: "all",
        observations: row.observations,
        segments: row.segments,
      },
      metrics: {
        "first_party:position": { value: row.position, unit: "rank", source: "first_party" },
        "first_party:clicks": { value: row.clicks, unit: "count", source: "first_party" },
        "first_party:impressions": { value: row.impressions, unit: "count", source: "first_party" },
        "first_party:ctr": { value: row.ctr, unit: "ratio", source: "first_party" },
      },
    });
  }
  if (previousPerformance.length === 0) result.skipped.push("no comparison window: decline cannot be measured yet");

  return result;
}

export type RefreshDb = BackfillDb & OpportunityDb & Pick<PrismaClient, "demandMapCluster" | "keyword" | "businessKnowledgeDocument">;

/**
 * Refresh the funnel for one site: backfill evidence from first-party stores,
 * then run every detector. Idempotent (evidence upserts by observation hash,
 * opportunities dedupe by key). Reads only; makes no paid calls.
 */
/**
 * The demand map has one owner. When the model has already stored topics for
 * this project, lexical discovery would retire them and invent a second map
 * from the same evidence; the job map owns the topics, so discovery does not
 * run and its untracked legacy rows are retired. A project with no model topics
 * still bootstraps through discovery. Returns `modelled: 0` when the caller
 * should run discovery, and `retired: -1` when it did not touch the table.
 */
export async function retireLegacyClustersForTopicMap(
  db: Pick<PrismaClient, "demandMapCluster">,
  projectId: string
): Promise<{ modelled: number; retired: number }> {
  const modelled = await db.demandMapCluster.count({
    where: { projectId, supersededAt: null, proposedBy: "topic-map-v1" },
  });
  if (modelled === 0) return { modelled, retired: -1 };
  const retired = await db.demandMapCluster.updateMany({
    where: { projectId, supersededAt: null, tracked: false, proposedBy: { not: "topic-map-v1" } },
    data: { supersededAt: new Date() },
  });
  return { modelled, retired: retired.count };
}

/**
 * Evidence only: backfill, business knowledge, question coverage, clusters.
 *
 * Split out so a shadow run can rebuild the inputs without running the detectors
 * that write opportunities. Evidence writes are additive and idempotent.
 */
export async function refreshEvidenceForSite(
  db: RefreshDb,
  siteId: string,
  opts: { projectId?: string } = {}
): Promise<{ backfill: BackfillResult; knowledgeFacts: number; questionCoverage: number }> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true } });
  const projectId = opts.projectId ?? site?.projectId;
  if (!projectId) {
    return {
      backfill: { projectId: null, crawlEvidence: 0, rankEvidence: 0, pageEvidence: 0, window: null, skipped: ["site is not attached to a project"] },
      knowledgeFacts: 0,
      questionCoverage: 0,
    };
  }
  const backfill = await backfillSiteEvidence(db, siteId, { projectId });
  const knowledge = await bridgeBusinessKnowledgeToEvidence(db as never, { projectId, siteId });
  const coverage = await bridgeQuestionCoverageToEvidence(db as never, { projectId, siteId });
  // Findings stored before the claim contract carry no verification. Re-check them
  // before detection so a contradicted premise cannot sit on the board for a month.
  try {
    await reassessLegacyFindings(db as never, { projectId, siteId });
  } catch (error) {
    console.error("[funnel] legacy finding reassessment failed", error);
  }
  const modelled = await retireLegacyClustersForTopicMap(db, projectId);
  if (modelled.modelled > 0) {
    backfill.skipped.push(
      `demand map is owned by the topic map; lexical discovery skipped${modelled.retired > 0 ? `, ${modelled.retired} legacy clusters retired` : ""}`
    );
  } else {
    await discoverClusters(db, projectId, { siteId });
  }
  return { backfill, knowledgeFacts: knowledge.stored, questionCoverage: coverage.stored };
}

export async function refreshFunnelForSite(
  db: RefreshDb,
  siteId: string,
  opts: { detectedBy?: string } = {}
): Promise<BackfillResult & { created: number; updated: number; parked: number; knowledgeFacts: number; questionCoverage: number }> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true, domain: true } });
  if (!site?.projectId) {
    return {
      projectId: null,
      crawlEvidence: 0,
      rankEvidence: 0,
      pageEvidence: 0,
      window: null,
      skipped: ["site is not attached to a project"],
      created: 0,
      updated: 0,
      parked: 0,
      knowledgeFacts: 0,
      questionCoverage: 0,
    };
  }
  // The why leg, question coverage and clusters all have to exist before
  // detection; refreshEvidenceForSite owns that order.
  const evidence = await refreshEvidenceForSite(db, siteId, { projectId: site.projectId });
  const detection = await runDetectors(db, site.projectId, {
    detectedBy: opts.detectedBy ?? "funnel-refresh",
    // The site's own name is not an opportunity: a brand query already ranks.
    brandTerms: brandTermsFromDomain(site.domain),
  });
  return {
    ...evidence.backfill,
    knowledgeFacts: evidence.knowledgeFacts,
    questionCoverage: evidence.questionCoverage,
    created: detection.created,
    updated: detection.updated,
    parked: detection.parked.length,
  };
}
