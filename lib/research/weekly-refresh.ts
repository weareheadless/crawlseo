import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { backfillSiteEvidence, type BackfillResult } from "@/lib/funnel/backfill";
import { parseOpportunityProposal } from "@/lib/funnel/proposal";
import {
  bridgeBusinessKnowledgeToEvidence,
  type BusinessKnowledgeBridgeResult,
} from "@/lib/projects/business-knowledge-evidence";
import {
  bridgeQuestionCoverageToEvidence,
  type QuestionCoverageResult,
} from "@/lib/research/question-coverage-evidence";
import { buildNewsQueries } from "@/lib/research/monthly-bundle";
import { storeProposals, type Proposal } from "@/lib/research/opportunity-generation";
import { buildClusterEvidenceCatalogue, buildClusterEvidenceIds } from "@/lib/research/opportunity-evidence";
import { draftTimelyProposals } from "@/lib/research/opportunity-drafting";
import { fetchGoogleNewsRssSearch } from "@/lib/research/providers/google-news-rss";
import type { ResearchProviderSource } from "@/lib/research/providers/types";
import { saveResearchSources } from "@/lib/research/service";
import { topicMapKey, type TopicMap } from "@/lib/research/topic-map";
import { loadTopicTaxonomy } from "@/lib/research/topic-taxonomy";
import { businessKnowledgeFields, resolveSiteContext } from "@/lib/site/context";

/**
 * Phase 5 weekly refresh.
 *
 * Weekly work is free: refresh the first-party evidence, run a bounded news
 * sweep, and raise a timely proposal only when a source is current. It does not
 * call DataForSEO, does not re-run the monthly bundle, and does not run the
 * generic cluster discovery (that would fork the reviewed topic map).
 *
 * The weekly run is a `ResearchRun` with key `weekly:<siteId>:<YYYY-Www>`; the
 * news sources are `ResearchSource` rows under that run. No task is created.
 */

export type WeeklyRefreshDb = PrismaClient;

export type WeeklyNewsItem = {
  provider: string;
  title: string;
  url: string;
  publishedAt: string | null;
  excerpt: string | null;
  contentHash: string | null;
};

export type WeeklyTimelyProposal = Proposal;

export type WeeklyRefreshResult = {
  status: "planned" | "completed" | "existing";
  runId: string | null;
  week: string;
  queries: string[];
  evidence: {
    crawl: number;
    gsc: number;
    knowledge: number;
    questionCoverage: number;
  };
  news: {
    fetched: number;
    stored: number;
    items: WeeklyNewsItem[];
  };
  timely: {
    proposals: WeeklyTimelyProposal[];
    stored: number;
    dropped: Array<{ title: string; reason: string }>;
    rejected: Array<{ title: string; reason: string }>;
    expired: number;
    reason: string | null;
  };
};

export type WeeklyDeps = {
  backfill: (db: WeeklyRefreshDb, siteId: string, opts: { projectId: string }) => Promise<BackfillResult>;
  bridgeKnowledge: (
    db: WeeklyRefreshDb,
    opts: { projectId: string; siteId: string }
  ) => Promise<BusinessKnowledgeBridgeResult>;
  bridgeCoverage: (
    db: WeeklyRefreshDb,
    opts: { projectId: string; siteId: string }
  ) => Promise<QuestionCoverageResult>;
  fetchNews: (input: {
    query: string;
    limit?: number;
    language?: string;
    country?: string;
  }) => Promise<ResearchProviderSource[]>;
  saveNews: (runId: string, sources: ResearchProviderSource[]) => Promise<Array<{ id: string }>>;
  storeProposals: typeof storeProposals;
  draftTimely: typeof draftTimelyProposals;
};

export const defaultWeeklyDeps: WeeklyDeps = {
  backfill: backfillSiteEvidence,
  bridgeKnowledge: bridgeBusinessKnowledgeToEvidence,
  bridgeCoverage: bridgeQuestionCoverageToEvidence,
  fetchNews: fetchGoogleNewsRssSearch,
  saveNews: saveResearchSources,
  storeProposals,
  draftTimely: draftTimelyProposals,
};

export function isoWeekKey(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function weeklyKey(siteId: string, week: string): string {
  return `weekly:${siteId}:${week}`;
}

export function buildWeeklyNewsQueries(input: {
  businessName: string | null;
  services: string[];
  location: string | null;
  serviceArea: string[];
  domain: string;
  year: number;
  /** Searches proposed for this tenant by the taxonomy; replaces the old
   *  hardcoded craft-event phrases. */
  taxonomyQueries?: string[];
}): string[] {
  const base = buildNewsQueries(
    {
      businessName: input.businessName,
      services: input.services,
      location: input.location,
      serviceArea: input.serviceArea,
      domain: input.domain,
    },
    6
  );
  const extra = (input.taxonomyQueries ?? []).map((query) => query.trim()).filter(Boolean);
  const seen = new Set<string>();
  return [...base, ...extra].filter((query) => {
    const key = query.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

export async function runWeeklyRefresh(
  db: WeeklyRefreshDb,
  input: {
    siteId: string;
    week?: string;
    mode: "dry-run" | "execute";
    refresh?: boolean;
    approval?: string | null;
    now?: Date;
  },
  deps: WeeklyDeps = defaultWeeklyDeps
): Promise<WeeklyRefreshResult> {
  const now = input.now ?? new Date();
  const week = input.week?.trim() || isoWeekKey(now);
  if (!/^\d{4}-W\d{2}$/.test(week)) throw new Error("--week must be YYYY-Www");
  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { id: true, domain: true, projectId: true, retiredAt: true },
  });
  if (!site) throw new Error(`site ${input.siteId} not found`);
  if (site.retiredAt) throw new Error(`site ${site.domain} is retired`);
  if (!site.projectId) throw new Error(`site ${site.domain} is not attached to a project`);

  const context = await resolveSiteContext(db, site.id);
  const fields = await businessKnowledgeFields(db, site.projectId);
  const taxonomy = await loadTopicTaxonomy(db, site.id);
  const queries = buildWeeklyNewsQueries({
    businessName: fieldText(fields, "businessName"),
    services: fieldList(fields, "services"),
    location: fieldText(fields, "location"),
    serviceArea: fieldList(fields, "serviceArea"),
    domain: site.domain,
    year: now.getUTCFullYear(),
    taxonomyQueries: taxonomy?.newsQueries,
  });

  const existing = await db.researchRun.findFirst({
    where: { siteId: site.id, idempotencyKey: weeklyKey(site.id, week) },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.status === "COMPLETED" && !input.refresh) {
    const report = existing.report as {
      evidence?: WeeklyRefreshResult["evidence"];
      news?: WeeklyRefreshResult["news"];
      timely?: WeeklyRefreshResult["timely"];
    } | null;
    return {
      status: "existing",
      runId: existing.id,
      week,
      queries,
      evidence: report?.evidence ?? { crawl: 0, gsc: 0, knowledge: 0, questionCoverage: 0 },
      news: report?.news ?? { fetched: 0, stored: 0, items: [] },
      timely: report?.timely ?? { proposals: [], stored: 0, dropped: [], rejected: [], expired: 0, reason: "existing run" },
    };
  }

  if (input.mode === "dry-run") {
    return {
      status: "planned",
      runId: null,
      week,
      queries,
      evidence: { crawl: 0, gsc: 0, knowledge: 0, questionCoverage: 0 },
      news: { fetched: 0, stored: 0, items: [] },
      timely: { proposals: [], stored: 0, dropped: [], rejected: [], expired: 0, reason: "dry run" },
    };
  }

  const run = existing
    ? await db.researchRun.update({
        where: { id: existing.id },
        data: { status: "RUNNING", completedAt: null, errorCode: null },
      })
    : await db.researchRun.create({
        data: {
          siteId: site.id,
          projectId: site.projectId,
          kind: "SEO",
          trigger: "SCHEDULED",
          status: "RUNNING",
          title: `Weekly refresh — ${week}`,
          brief: {
            week,
            approvalReference: input.approval ?? null,
            queries,
            cadence: "weekly",
          } as never,
          topics: queries.slice(0, 12) as never,
          recencyDays: 14,
          promptVersion: "weekly-refresh-v1",
          idempotencyKey: weeklyKey(site.id, week),
          requestedBy: "research-weekly-cli",
          startedAt: now,
        },
      });

  try {
    const backfill = await deps.backfill(db, site.id, { projectId: site.projectId });
    const knowledge = await deps.bridgeKnowledge(db, { projectId: site.projectId, siteId: site.id });
    const coverage = await deps.bridgeCoverage(db, { projectId: site.projectId, siteId: site.id });

    const fetched: ResearchProviderSource[] = [];
    for (const query of queries) {
      try {
        const items = await deps.fetchNews({
          query,
          limit: 10,
          language: context.language,
          country: context.country ?? undefined,
        });
        for (const item of items) {
          if (fetched.some((existingItem) => existingItem.contentHash === item.contentHash || existingItem.url === item.url)) continue;
          fetched.push({ ...item, metadata: { ...(item.metadata ?? {}), query } });
        }
      } catch {
        // A single failed feed is a partial sweep, not a failed run.
      }
    }
    const saved = fetched.length > 0 ? await deps.saveNews(run.id, fetched.slice(0, 20)) : [];
    const newsItems: WeeklyNewsItem[] = fetched.slice(0, 20).map((item) => ({
      provider: item.provider,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt ?? null,
      excerpt: item.excerpt ?? null,
      contentHash: item.contentHash ?? null,
    })).sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""));

    const topicRun = await db.researchRun.findFirst({
      where: { siteId: site.id, idempotencyKey: topicMapKey(site.id, now.toISOString().slice(0, 7)) },
      orderBy: { createdAt: "desc" },
    });
    const topicReport = topicRun?.report as { map?: TopicMap } | null;
    const map = topicReport?.map;
    const clusters = map
      ? await db.demandMapCluster.findMany({
          where: { projectId: site.projectId, slug: { in: map.clusters.map((cluster) => cluster.slug) }, supersededAt: null },
          select: { id: true, slug: true },
        })
      : [];
    const knowledgeEvidence = await db.evidenceRecord.findMany({
      where: { projectId: site.projectId, siteId: site.id, kind: "knowledge_fact", supersededById: null },
      select: { id: true },
      take: 4,
    });
    const clusterEvidenceRows = map
      ? await db.evidenceRecord.findMany({
          where: {
            projectId: site.projectId,
            siteId: site.id,
            kind: { in: ["keyword_rank", "keyword_metrics", "serp_snapshot", "keyword_universe_membership"] },
            supersededById: null,
          },
          select: { id: true, kind: true, dimensions: true, metrics: true, observedAt: true },
        })
      : [];
    const clusterEvidence = map ? buildClusterEvidenceIds(map.clusters, clusterEvidenceRows) : new Map<string, string[]>();

    // Expire timely items that were detected but never accepted. Expiry is a
    // park, not a delete: the row and its evidence stay for audit.
    const expiring = await db.opportunity.findMany({
      where: {
        projectId: site.projectId,
        status: "detected",
        detectedBy: { in: ["phase3:topic-map", "phase5:weekly"] },
      },
      select: { id: true, recommendationDecision: true },
    });
    const expiredIds = expiring
      .filter((row) => {
        const proposal = parseOpportunityProposal(row.recommendationDecision);
        return Boolean(proposal?.expiresAt && Date.parse(proposal.expiresAt) <= now.getTime());
      })
      .map((row) => row.id);
    if (expiredIds.length > 0) {
      await db.opportunity.updateMany({
        where: { id: { in: expiredIds } },
        data: { status: "parked", parkReason: "timely item expired" },
      });
    }

    const timely = map
      ? await deps.draftTimely({
          map,
          marketScope: map.marketScope,
          evidenceByCluster: buildClusterEvidenceCatalogue(map.clusters, clusterEvidenceRows, clusterEvidence),
          aeoQuestions: [],
          news: newsItems.map((item) => ({
            id: item.url,
            title: item.title,
            url: item.url,
            publishedAt: item.publishedAt,
            excerpt: item.excerpt,
          })),
          knowledgeEvidenceIds: knowledgeEvidence.map((row) => row.id),
          now,
        })
      : { proposals: [], errors: ["no topic map for this month"], rejected: [], summary: null, model: null };

    let stored = 0;
    let dropped: Array<{ title: string; reason: string }> = [];
    if (map && timely.proposals.length > 0) {
      const evidenceRows = await db.evidenceRecord.findMany({
        where: { projectId: site.projectId, siteId: site.id },
        select: { id: true },
      });
      const result = await deps.storeProposals(db, {
        projectId: site.projectId,
        siteId: site.id,
        domain: site.domain,
        map,
        topicMapRunId: topicRun?.id ?? "",
        proposals: timely.proposals,
        detectedBy: "phase5:weekly",
        evidenceIds: new Set(evidenceRows.map((row) => row.id)),
        knowledgeEvidenceIds: knowledgeEvidence.map((row) => row.id),
        clusters,
      });
      stored = result.stored.length;
      dropped = result.dropped;
      const currentKeys = new Set(timely.proposals.map((proposal) => proposal.dedupKey));
      const existingTimely = await db.opportunity.findMany({
        where: { projectId: site.projectId, detectedBy: "phase5:weekly", status: "detected" },
        select: { id: true, dedupKey: true },
      });
      const stale = existingTimely.filter((row) => !currentKeys.has(row.dedupKey));
      if (stale.length > 0) {
        await db.opportunity.updateMany({
          where: { id: { in: stale.map((row) => row.id) } },
          data: { status: "closed", parkReason: "superseded by refreshed timely sweep" },
        });
      }
    } else if (!map) {
      dropped = [{ title: "timely proposals", reason: "no topic map for this month; proposals were not stored" }];
    }

    const evidence = {
      crawl: backfill.crawlEvidence,
      gsc: backfill.rankEvidence + backfill.pageEvidence,
      knowledge: knowledge.stored,
      questionCoverage: coverage.stored,
    };
    const report = {
      version: 1,
      week,
      site: { id: site.id, domain: site.domain },
      evidence,
      news: { fetched: fetched.length, stored: saved.length, items: newsItems },
      timely: {
        proposals: timely.proposals,
        stored,
        dropped,
        rejected: timely.rejected,
        expired: expiredIds.length,
        reason: timely.errors.length > 0 ? timely.errors.join("; ") : timely.summary,
      },
      approvalReference: input.approval ?? null,
      generatedAt: new Date().toISOString(),
      counts: {
        queries: queries.length,
        newsFetched: fetched.length,
        newsStored: saved.length,
        timelyProposals: timely.proposals.length,
        timelyStored: stored,
      },
    };
    await db.researchRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        report: report as never,
        completedAt: new Date(),
        sourceCount: saved.length,
        findingCount: 0,
        actionCount: 0,
        costMicros: 0,
      },
    });
    return {
      status: "completed",
      runId: run.id,
      week,
      queries,
      evidence,
      news: { fetched: fetched.length, stored: saved.length, items: newsItems },
      timely: { proposals: timely.proposals, stored, dropped, rejected: timely.rejected, expired: expiredIds.length, reason: timely.errors.length > 0 ? timely.errors.join("; ") : timely.summary },
    };
  } catch (error) {
    await db.researchRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorCode: "WEEKLY_REFRESH_FAILED",
        report: { error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) } as never,
      },
    });
    throw error;
  }
}

export function renderWeeklyReport(result: WeeklyRefreshResult, domain: string): string {
  const lines: string[] = [];
  lines.push(`# Weekly refresh — ${domain} — ${result.week}`);
  lines.push("");
  lines.push(`Run ${result.runId ?? "not stored"}. Free weekly work: first-party evidence and news, no DataForSEO.`);
  lines.push("");
  lines.push("## Evidence refreshed");
  lines.push("");
  lines.push(`- Crawl observations: ${result.evidence.crawl}`);
  lines.push(`- GSC observations: ${result.evidence.gsc}`);
  lines.push(`- Business knowledge facts: ${result.evidence.knowledge}`);
  lines.push(`- Question coverage: ${result.evidence.questionCoverage}`);
  lines.push("");
  lines.push("## News sweep");
  lines.push("");
  lines.push(`- Queries: ${result.queries.length}`);
  lines.push(`- Sources fetched: ${result.news.fetched}; stored: ${result.news.stored}`);
  lines.push("");
  if (result.news.items.length > 0) {
    lines.push("| Published | Source |");
    lines.push("|---|---|");
    for (const item of result.news.items.slice(0, 15)) {
      lines.push(`| ${item.publishedAt?.slice(0, 10) ?? "—"} | ${item.title.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  lines.push("## Timely proposals");
  lines.push("");
  if (result.timely.expired > 0) lines.push(`- Expired timely items parked: ${result.timely.expired}`);
  if (result.timely.proposals.length === 0) {
    lines.push(`No timely proposal. ${result.timely.reason ?? ""}`);
  } else {
    for (const proposal of result.timely.proposals) {
      lines.push(`- **${proposal.title}** — ${proposal.whyNow ?? ""}`);
      lines.push(`  - Action: ${proposal.action}`);
      lines.push(`  - Target: ${proposal.target.url ?? (proposal.target.newAsset ? "new asset" : "none")}`);
      lines.push(`  - Expires: ${proposal.expiresAt?.slice(0, 10) ?? "—"}`);
      lines.push(`  - Stored: ${result.timely.stored > 0 ? "yes" : "no"}`);
    }
  }
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  lines.push("- Weekly work does not call DataForSEO and does not re-run the monthly bundle.");
  lines.push("- The crawl itself is a separate scheduled job; this run projects the latest completed crawl and Search Console window.");
  lines.push("- No task is created; a timely proposal still needs human acceptance on the board.");
  lines.push("");
  return lines.join("\n");
}

function fieldText(fields: Record<string, unknown>, key: string): string | null {
  const fact = asRecord(fields[key]);
  const value = fact.value;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join("; ") : null;
  }
  return null;
}

function fieldList(fields: Record<string, unknown>, key: string): string[] {
  const fact = asRecord(fields[key]);
  const value = fact.value;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
