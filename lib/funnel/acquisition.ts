import type { PrismaClient } from "@prisma/client";

import { readQueryPagePerformance } from "@/lib/funnel/gsc-performance";
import type { PerformanceWindow, QueryPagePerformance } from "@/lib/funnel/performance-window";

/**
 * Acquisition planning (plan P4).
 *
 * Paid collection used to run only as a join on an opportunity a model had already
 * invented: a research finding said "people ask about X", then we bought volume for
 * X. The queries the site was already observed ranking for were never enriched, so
 * on a connected site the measured phrases and the ranking phrases were disjoint —
 * seven measured keywords, zero of them matching a ranking query, and therefore no
 * effect on the board.
 *
 * This module inverts the order: enrich observed performance first, then hypotheses.
 * Every request states why it was made, so spend can be audited against a decision.
 */

/** Below this many impressions a query is not worth a paid measurement yet. */
export const MIN_OBSERVED_IMPRESSIONS = 10;

/** A measurement older than this is refreshed rather than reused. */
export const MEASUREMENT_TTL_DAYS = 45;

/** The provider accepts a bounded batch per call. */
export const ACQUISITION_BATCH_SIZE = 20;

export type ObservedCandidate = {
  query: string;
  url: string | null;
  impressions: number;
  clicks: number;
  position: number | null;
};

export type HypothesisCandidate = {
  query: string;
  opportunityId: string;
  title?: string;
};

export type AcquisitionRequest = {
  query: string;
  reason: "observed_performance" | "research_hypothesis";
  /** Higher runs first. Observed demand always outranks a hypothesis. */
  priority: number;
  observedImpressions: number | null;
  opportunityIds: string[];
};

export type AcquisitionPlan = {
  requests: AcquisitionRequest[];
  skipped: Array<{ query: string; reason: string }>;
};

const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Order what to measure.
 *
 * Observed performance first, by impressions — the site has already been shown to
 * appear for these, so a volume is the missing half of a decision. Hypotheses come
 * after, and never displace an observed query for the same budget.
 */
export function planAcquisition(input: {
  observed: ObservedCandidate[];
  hypotheses?: HypothesisCandidate[];
  measuredQueries?: Iterable<string>;
  limit?: number;
}): AcquisitionPlan {
  const measured = new Set([...(input.measuredQueries ?? [])].map(normalize));
  const skipped: AcquisitionPlan["skipped"] = [];
  const requests: AcquisitionRequest[] = [];
  const seen = new Set<string>();

  const observed = [...input.observed]
    .filter((row) => row.query.trim().length > 0)
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
  for (const row of observed) {
    const key = normalize(row.query);
    if (seen.has(key)) continue;
    if (measured.has(key)) {
      skipped.push({ query: row.query, reason: "already measured and still fresh" });
      continue;
    }
    if (row.impressions < MIN_OBSERVED_IMPRESSIONS) {
      skipped.push({ query: row.query, reason: `only ${Math.round(row.impressions)} impressions in the window` });
      continue;
    }
    seen.add(key);
    requests.push({
      query: row.query,
      reason: "observed_performance",
      priority: 1_000 + row.impressions,
      observedImpressions: row.impressions,
      opportunityIds: [],
    });
  }

  const byQuery = new Map<string, AcquisitionRequest>();
  for (const hypothesis of input.hypotheses ?? []) {
    const key = normalize(hypothesis.query);
    if (!key) continue;
    if (measured.has(key)) {
      skipped.push({ query: hypothesis.query, reason: "already measured and still fresh" });
      continue;
    }
    const existing = byQuery.get(key);
    if (existing) {
      if (!existing.opportunityIds.includes(hypothesis.opportunityId)) existing.opportunityIds.push(hypothesis.opportunityId);
      continue;
    }
    if (seen.has(key)) continue;
    const request: AcquisitionRequest = {
      query: hypothesis.query,
      reason: "research_hypothesis",
      priority: 100,
      observedImpressions: null,
      opportunityIds: [hypothesis.opportunityId],
    };
    byQuery.set(key, request);
    requests.push(request);
  }

  const limit = input.limit ?? 40;
  const bounded = requests.slice(0, limit);
  for (const request of requests.slice(limit)) {
    skipped.push({ query: request.query, reason: "budget: outside this month's acquisition limit" });
  }
  return { requests: bounded, skipped };
}

export type AcquisitionReceipt = {
  window: { start: string; end: string; days: number } | null;
  requested: number;
  measured: number;
  failed: number;
  cached: number;
  spentMicros: number;
  requests: Array<{ query: string; reason: AcquisitionRequest["reason"]; state: "measured" | "cached" | "failed" }>;
  skipped: Array<{ query: string; reason: string }>;
};

export type AcquisitionDb = Pick<PrismaClient, "keyword" | "page" | "evidenceRecord" | "$queryRaw">;

export type AcquisitionCollector = (input: {
  projectId: string;
  siteId: string | null;
  queries: string[];
}) => Promise<{ evidence: Array<{ id: string }>; spentMicros: number }>;

/** Queries already measured by the provider, with the age of the measurement. */
export async function measuredQueries(
  db: AcquisitionDb,
  projectId: string,
  now = new Date()
): Promise<Set<string>> {
  const rows = await db.evidenceRecord.findMany({
    where: { projectId, kind: "keyword_metrics", supersededById: null },
    select: { dimensions: true, observedAt: true },
  });
  const fresh = new Set<string>();
  for (const row of rows) {
    const query = (row.dimensions as { query?: unknown } | null)?.query;
    if (typeof query !== "string" || !query) continue;
    const ageDays = (now.getTime() - row.observedAt.getTime()) / 86_400_000;
    if (ageDays <= MEASUREMENT_TTL_DAYS) fresh.add(query);
  }
  return fresh;
}

/**
 * Enrich the queries the site is already observed ranking for, then the
 * hypotheses, within the caller's spend ceiling.
 *
 * Collection is batched and stops as soon as the ceiling is reached; a failure is
 * recorded per batch and does not abort the rest of the plan.
 */
export async function runAcquisitionPlan(
  db: AcquisitionDb,
  input: {
    projectId: string;
    siteId: string | null;
    window: PerformanceWindow;
    performance: QueryPagePerformance[];
    hypotheses?: HypothesisCandidate[];
    collect: AcquisitionCollector;
    /** Hard ceiling for this analysis pass. */
    maxSpendMicros: number;
    now?: Date;
  }
): Promise<AcquisitionReceipt> {
  const alreadyMeasured = await measuredQueries(db, input.projectId, input.now);
  const plan = planAcquisition({
    observed: input.performance.map((row) => ({
      query: row.query,
      url: row.url,
      impressions: row.impressions,
      clicks: row.clicks,
      position: row.position,
    })),
    hypotheses: input.hypotheses,
    measuredQueries: alreadyMeasured,
  });

  const receipt: AcquisitionReceipt = {
    window: {
      start: input.window.start.toISOString(),
      end: input.window.end.toISOString(),
      days: input.window.days,
    },
    requested: plan.requests.length,
    measured: 0,
    failed: 0,
    cached: plan.skipped.filter((entry) => entry.reason.startsWith("already measured")).length,
    spentMicros: 0,
    requests: [],
    skipped: plan.skipped,
  };

  for (let index = 0; index < plan.requests.length; index += ACQUISITION_BATCH_SIZE) {
    const batch = plan.requests.slice(index, index + ACQUISITION_BATCH_SIZE);
    if (receipt.spentMicros >= input.maxSpendMicros) {
      for (const request of batch) receipt.skipped.push({ query: request.query, reason: "budget: spend ceiling reached" });
      continue;
    }
    try {
      const result = await input.collect({
        projectId: input.projectId,
        siteId: input.siteId,
        queries: batch.map((request) => request.query),
      });
      receipt.spentMicros += result.spentMicros;
      const measuredSet = new Set(
        result.evidence
          .map((row) => (row as { dimensions?: { query?: unknown } }).dimensions?.query)
          .filter((value): value is string => typeof value === "string")
          .map(normalize)
      );
      for (const request of batch) {
        const measured = measuredSet.size === 0 || measuredSet.has(normalize(request.query));
        if (measured) receipt.measured += 1;
        else receipt.failed += 1;
        receipt.requests.push({
          query: request.query,
          reason: request.reason,
          state: measured ? "measured" : "failed",
        });
      }
    } catch (error) {
      for (const request of batch) {
        receipt.failed += 1;
        receipt.requests.push({ query: request.query, reason: request.reason, state: "failed" });
        receipt.skipped.push({
          query: request.query,
          reason: error instanceof Error ? error.message.slice(0, 160) : "collection failed",
        });
      }
    }
  }

  return receipt;
}

/** The current window's performance, read for planning only. */
export async function observedPerformance(
  db: AcquisitionDb,
  siteId: string,
  window: PerformanceWindow
): Promise<QueryPagePerformance[]> {
  return readQueryPagePerformance(db, siteId, window);
}
