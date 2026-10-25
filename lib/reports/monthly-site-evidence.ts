import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { projectSite as resolveProjectSite } from "@/lib/projects/project-site";
import {
  closedPeriod,
  ensureSourcePrerequisites,
  firstPartyEvidence,
  historicalEvidence,
  sourcePrerequisites,
} from "@/lib/dataforseo/research";

export const MONTHLY_SITE_EVIDENCE_SCHEMA_VERSION = 1;

export class MonthlyEvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonthlyEvidenceValidationError";
  }
}

function validatePeriod(period: string): void {
  closedPeriod(period);
  const currentMonth = new Date(`${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`);
  if (closedPeriod(period).start >= currentMonth) {
    throw new MonthlyEvidenceValidationError("period must be a closed calendar month");
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sourceStates(prerequisites: Awaited<ReturnType<typeof sourcePrerequisites>>) {
  return {
    gsc: {
      status: prerequisites.sources.gsc.ready ? "ready" : prerequisites.sources.gsc.connected ? "waiting" : "unavailable",
      connected: prerequisites.sources.gsc.connected,
      coverage: prerequisites.sources.gsc.coverage,
      last_status: prerequisites.sources.gsc.last_status,
      error_code: prerequisites.sources.gsc.error_code,
    },
    ga4: {
      status: prerequisites.sources.ga4.ready ? "ready" : prerequisites.sources.ga4.connected ? "waiting" : "unavailable",
      connected: prerequisites.sources.ga4.connected,
      coverage: prerequisites.sources.ga4.coverage,
      last_status: prerequisites.sources.ga4.last_status,
      error_code: prerequisites.sources.ga4.error_code,
    },
    crawl: {
      status: prerequisites.sources.crawl.ready ? "ready" : "waiting",
      finished_at: prerequisites.sources.crawl.finishedAt,
    },
  };
}

function ga4Previous(history: Awaited<ReturnType<typeof historicalEvidence>>, period: string): unknown {
  const current = new Date(`${period}-01T00:00:00.000Z`);
  current.setUTCMonth(current.getUTCMonth() - 1);
  const previousPeriod = current.toISOString().slice(0, 7);
  return history.ga4_months.find((snapshot) => snapshot.month === previousPeriod)?.summary ?? null;
}

function boundedEvidence(
  period: string,
  firstParty: Awaited<ReturnType<typeof firstPartyEvidence>>,
  history: Awaited<ReturnType<typeof historicalEvidence>>
) {
  const periodRange = closedPeriod(period);
  const metrics = firstParty.gsc.metrics;
  const currentMetrics = metrics?.current ?? null;
  const previousMetrics = metrics?.previous ?? null;
  const ga4Summary = jsonObject(firstParty.ga4.summary);
  return {
    schema_version: MONTHLY_SITE_EVIDENCE_SCHEMA_VERSION,
    period,
    status: "ready",
    gsc: {
      status: "ready",
      period_start: periodRange.startDate,
      period_end: periodRange.endDate,
      clicks: currentMetrics?.clicks ?? 0,
      impressions: currentMetrics?.impressions ?? 0,
      ctr: currentMetrics?.avgCtr ?? 0,
      position: currentMetrics && currentMetrics.avgPosition > 0 ? currentMetrics.avgPosition : null,
      top_queries: firstParty.gsc.top_queries.slice(0, 50),
      top_pages: firstParty.gsc.top_pages.slice(0, 50),
      previous_period: previousMetrics ?? {},
    },
    ga4: {
      status: "ready",
      period_start: firstParty.ga4.coverage?.startDate ?? periodRange.startDate,
      period_end: firstParty.ga4.coverage?.endDate ?? periodRange.endDate,
      totals: ga4Summary,
      top_pages: Array.isArray(ga4Summary.top_pages) ? ga4Summary.top_pages.slice(0, 50) : [],
      sources: Array.isArray(ga4Summary.sources) ? ga4Summary.sources.slice(0, 50) : [],
      previous_period: ga4Previous(history, period),
    },
    crawl: {
      status: "ready",
      crawl_id: firstParty.crawl.crawl_id,
      finished_at: firstParty.crawl.finished_at,
      health_score: firstParty.crawl.latest?.healthScore ?? null,
      page_count: firstParty.crawl.latest?.pagesFound ?? 0,
      issue_count: firstParty.crawl.latest?.issuesFound ?? 0,
      issues: (firstParty.crawl.latest?.issues ?? []).slice(0, 100),
    },
    recent_content: firstParty.gsc.top_pages.slice(0, 10),
    history: {
      gsc_months: history.windows.six_months,
      ga4_months: history.ga4_months.slice(-6),
      history_state: history.windows.history_state,
    },
    freshness: {
      gsc_sync_run_id: firstParty.gsc.sync_run_id,
      gsc_completed_at: firstParty.gsc.completed_at,
      ga4_snapshot_id: firstParty.ga4.snapshot_id,
      ga4_captured_at: firstParty.ga4.captured_at,
      crawl_id: firstParty.crawl.crawl_id,
      crawl_finished_at: firstParty.crawl.finished_at,
    },
  };
}

export async function prepareMonthlySiteEvidence(input: {
  projectId: string;
  period: string;
  idempotencyKey: string;
  maxCrawlPages?: number;
}) {
  validatePeriod(input.period);
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 240) {
    throw new MonthlyEvidenceValidationError("idempotency_key is invalid");
  }
  let site;
  try {
    site = await resolveProjectSite(input.projectId);
  } catch {
    throw new MonthlyEvidenceValidationError("Project has no site");
  }
  const prerequisites = await ensureSourcePrerequisites(
    input.projectId,
    site.id,
    input.period,
    input.maxCrawlPages ?? 200
  );
  if (!prerequisites.ready) {
    return {
      schema_version: MONTHLY_SITE_EVIDENCE_SCHEMA_VERSION,
      period: input.period,
      status: "waiting_for_sources",
      source_states: sourceStates(prerequisites),
      queued_jobs: prerequisites.queued_jobs,
      idempotency_key: input.idempotencyKey,
    };
  }
  const evidence = await getMonthlySiteEvidence(input.projectId, input.period);
  return { ...evidence, queued_jobs: prerequisites.queued_jobs, idempotency_key: input.idempotencyKey };
}

export async function getMonthlySiteEvidence(projectId: string, period: string) {
  validatePeriod(period);
  let site;
  try {
    site = await resolveProjectSite(projectId);
  } catch {
    throw new MonthlyEvidenceValidationError("Project has no site");
  }
  const prerequisites = await sourcePrerequisites(projectId, site.id, period);
  if (!prerequisites.ready) {
    return {
      schema_version: MONTHLY_SITE_EVIDENCE_SCHEMA_VERSION,
      period,
      status: "waiting_for_sources",
      source_states: sourceStates(prerequisites),
      queued_jobs: [],
    };
  }
  const [firstParty, history] = await Promise.all([
    firstPartyEvidence(site.id, period),
    historicalEvidence(site.id, period),
  ]);
  return boundedEvidence(period, firstParty, history);
}

export function monthlyEvidenceHash(evidence: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(evidence), "utf8")
    .digest("hex");
}

export type MonthlySiteEvidence = ReturnType<typeof boundedEvidence>;
