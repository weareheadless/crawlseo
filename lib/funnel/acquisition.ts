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
  /** How many independent observations support the need. */
  observations?: number;
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
  /** Queries already asked and answered with no data; not worth paying twice. */
  noDataQueries?: Iterable<string>;
  limit?: number;
  /**
   * Share of the limit reserved for customer-need queries.
   *
   * Observed queries are ordered by impressions, so incidental traffic can consume
   * the whole budget and starve the needs the site exists to answer. The reserve is
   * released back to observed queries when the needs do not use it.
   */
  needReserve?: number;
}): AcquisitionPlan {
  const measured = new Set([...(input.measuredQueries ?? [])].map(normalize));
  const noData = new Set([...(input.noDataQueries ?? [])].map(normalize));
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
    if (noData.has(key)) {
      skipped.push({ query: row.query, reason: "already measured with no data; the result is cached" });
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
    if (noData.has(key)) {
      skipped.push({ query: hypothesis.query, reason: "already measured with no data; the result is cached" });
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
  const observedRequests = requests.filter((row) => row.reason === "observed_performance");
  const needRequests = requests.filter((row) => row.reason !== "observed_performance");

  // Reserve part of the budget for customer needs. When there are no observed
  // queries at all the reserve is irrelevant and the needs take the whole budget.
  const reserve = observedRequests.length === 0
    ? needRequests.length
    : Math.max(0, Math.min(needRequests.length, Math.round(limit * (input.needReserve ?? 0.25))));
  const needChosen = needRequests.slice(0, reserve);
  const observedChosen = observedRequests.slice(0, Math.max(0, limit - needChosen.length));
  // Observed queries run first within the plan; the reserve only guarantees the
  // needs a slot, it does not make them the first batch.
  const chosen = [...observedChosen, ...needChosen];

  // Release an unused reserve back to the remaining requests.
  if (chosen.length < limit) {
    const chosenKeys = new Set(chosen.map((row) => normalize(row.query)));
    for (const request of [...needRequests, ...observedRequests]) {
      if (chosen.length >= limit) break;
      if (chosenKeys.has(normalize(request.query))) continue;
      chosen.push(request);
      chosenKeys.add(normalize(request.query));
    }
  }

  const bounded = chosen.slice(0, limit);
  const boundedKeys = new Set(bounded.map((row) => normalize(row.query)));
  for (const request of requests) {
    if (boundedKeys.has(normalize(request.query))) continue;
    skipped.push({ query: request.query, reason: "budget: outside this month's acquisition limit" });
  }
  return { requests: bounded, skipped };
}

export type AcquisitionReceipt = {
  window: { start: string; end: string; days: number } | null;
  requested: number;
  measured: number;
  /** The provider had no measurement for the query (not an error). */
  noData: number;
  failed: number;
  cached: number;
  spentMicros: number;
  requests: Array<{ query: string; reason: AcquisitionRequest["reason"]; state: "measured" | "no_data" | "failed" }>;
  skipped: Array<{ query: string; reason: string }>;
};

export type AcquisitionDb = Pick<PrismaClient, "keyword" | "page" | "evidenceRecord" | "$queryRaw">;

export type AcquisitionCollector = (input: {
  projectId: string;
  siteId: string | null;
  queries: string[];
}) => Promise<{ evidence: Array<{ id: string }>; spentMicros: number }>;

/**
 * Queries already asked about, split by outcome.
 *
 * A provider answering "no data" is a measurement too. Without caching it, every
 * pass paid again for the same twenty phrases that have no volume.
 */
export async function measuredQueries(
  db: AcquisitionDb,
  projectId: string,
  now = new Date()
): Promise<{ fresh: Set<string>; noData: Set<string> }> {
  const rows = await db.evidenceRecord.findMany({
    where: { projectId, kind: "keyword_metrics", supersededById: null },
    select: { dimensions: true, observedAt: true },
  });
  const fresh = new Set<string>();
  const noData = new Set<string>();
  for (const row of rows) {
    const dimensions = row.dimensions as { query?: unknown; noData?: unknown } | null;
    const query = dimensions?.query;
    if (typeof query !== "string" || !query) continue;
    const ageDays = (now.getTime() - row.observedAt.getTime()) / 86_400_000;
    if (ageDays > MEASUREMENT_TTL_DAYS) continue;
    if (dimensions?.noData === "true") noData.add(query);
    else fresh.add(query);
  }
  return { fresh, noData };
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
  const cache = await measuredQueries(db, input.projectId, input.now);
  const plan = planAcquisition({
    observed: input.performance.map((row) => ({
      query: row.query,
      url: row.url,
      impressions: row.impressions,
      clicks: row.clicks,
      position: row.position,
    })),
    hypotheses: input.hypotheses,
    measuredQueries: cache.fresh,
    noDataQueries: cache.noData,
  });

  const receipt: AcquisitionReceipt = {
    window: {
      start: input.window.start.toISOString(),
      end: input.window.end.toISOString(),
      days: input.window.days,
    },
    requested: plan.requests.length,
    measured: 0,
    noData: 0,
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
      // A provider returning nothing for a query is not a failure: the query may
      // simply have no volume. Only a thrown call is a failure.
      for (const request of batch) {
        const state = measuredSet.has(normalize(request.query)) ? "measured" : "no_data";
        if (state === "measured") receipt.measured += 1;
        else {
          receipt.noData += 1;
          // Cache the no-data answer with an expiry, so the next pass does not pay
          // for the same phrase again.
          await recordNoData(db, input.projectId, input.siteId, request.query, input.now ?? new Date());
        }
        receipt.requests.push({ query: request.query, reason: request.reason, state });
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

/** Persist a "provider has no volume for this" answer, with its observation time. */
async function recordNoData(
  db: AcquisitionDb,
  projectId: string,
  siteId: string | null,
  query: string,
  now: Date
): Promise<void> {
  try {
    const { storeEvidenceRecord } = await import("@/lib/funnel/evidence");
    await storeEvidenceRecord(db as never, {
      projectId,
      siteId,
      kind: "keyword_metrics",
      observedAt: now,
      producer: "dataforseo",
      dimensions: { query, noData: "true" },
      metrics: {},
    });
  } catch {
    // A cache write failure must not fail the acquisition pass.
  }
}

/** The current window's performance, read for planning only. */
export async function observedPerformance(
  db: AcquisitionDb,
  siteId: string,
  window: PerformanceWindow
): Promise<QueryPagePerformance[]> {
  return readQueryPagePerformance(db, siteId, window);
}
