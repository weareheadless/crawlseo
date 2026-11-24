import type { PrismaClient } from "@prisma/client";

import { BUNDLE_COST_ESTIMATES, estimateKeywordBatchMicros } from "@/lib/research/monthly-bundle";
import { collectKeywordMetrics } from "@/lib/dataforseo/collection";

/**
 * CMP-005: measure the demand behind the tracked grid.
 *
 * The board could not say what a win is worth on most queries, so rows sat at
 * score 1 behind a hypothesis ceiling. This pass buys the missing measurement for
 * the queries a cluster actually tracks, from the collector that already exists —
 * no new provider call, no new evidence kind.
 *
 * What it must not do, and does not:
 *  - **Invent a volume.** A query the provider returns nothing for stays
 *    `volume: null` and is reported as not measured. There is no fallback number:
 *    that is the "120 searches/month" bug this codebase already removed.
 *  - **Hide a cap.** The batch size and the total are bounded, and everything not
 *    sent is counted in `truncations` so the report says so.
 *  - **Buy twice in a month.** A query that already has a `keyword_metrics` row
 *    since the month start is reused, not re-bought.
 *
 * The measurement is a fact; which queries to measure is a decision somebody made
 * when they declared the grid.
 */

/** The provider's own limit per keyword-overview request. */
export const KEYWORD_BATCH_SIZE = BUNDLE_COST_ESTIMATES.keywordBatchSize;

export type VolumePlan = {
  /** Queries with a grid membership and no measurement this month. */
  toMeasure: string[];
  /** Queries already measured this month, so nothing is bought for them. */
  reused: string[];
  /** Batches and what they are estimated to cost. */
  batches: Array<{ queries: string[]; estimatedMicros: number }>;
  estimatedMicros: number;
  batchSize: number;
};

export type VolumeDb = Pick<PrismaClient, "evidenceRecord" | "demandMapCluster">;

/**
 * Read the grid and subtract what this month already measured.
 *
 * The grid comes from CMP-004's declaration (`grid: "tracked"` on the membership),
 * so the pass measures what somebody chose to watch rather than every query the
 * site happens to have. A site with no declared grid measures nothing and says so.
 */
export async function planVolumeMeasurement(
  db: VolumeDb,
  input: { projectId: string; monthStart: Date }
): Promise<VolumePlan> {
  const [memberships, measured] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { projectId: input.projectId, kind: "keyword_universe_membership", supersededById: null },
      select: { dimensions: true },
    }),
    db.evidenceRecord.findMany({
      where: {
        projectId: input.projectId,
        kind: "keyword_metrics",
        supersededById: null,
        observedAt: { gte: input.monthStart },
      },
      select: { dimensions: true },
    }),
  ]);

  const measuredThisMonth = new Set<string>();
  for (const row of measured) {
    const query = (row.dimensions as { query?: string })?.query;
    if (typeof query === "string" && query.trim()) measuredThisMonth.add(query.trim().toLowerCase());
  }

  const grid: string[] = [];
  const seen = new Set<string>();
  for (const row of memberships) {
    const dims = (row.dimensions ?? {}) as { query?: string; grid?: string };
    if (dims.grid !== "tracked" || typeof dims.query !== "string") continue;
    const trimmed = dims.query.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    grid.push(trimmed);
  }

  const toMeasure: string[] = [];
  const reused: string[] = [];
  for (const query of grid) {
    if (measuredThisMonth.has(query.toLowerCase())) reused.push(query);
    else toMeasure.push(query);
  }

  const batches: VolumePlan["batches"] = [];
  for (let index = 0; index < toMeasure.length; index += KEYWORD_BATCH_SIZE) {
    const queries = toMeasure.slice(index, index + KEYWORD_BATCH_SIZE);
    batches.push({ queries, estimatedMicros: estimateKeywordBatchMicros(queries.length) });
  }

  return {
    toMeasure,
    reused,
    batches,
    estimatedMicros: batches.reduce((sum, batch) => sum + batch.estimatedMicros, 0),
    batchSize: KEYWORD_BATCH_SIZE,
  };
}

export type VolumeResult = {
  /** Queries written with a provider volume. */
  measured: Array<{ query: string; volume: number }>;
  /** Queries the provider returned nothing for. Not a zero — an absence. */
  unmeasured: string[];
  /** Queries never sent because the cap was reached. */
  truncations: { count: number; queries: string[] };
  spentMicros: number;
  batches: number;
  error?: string;
};

/**
 * Run the measurement.
 *
 * `apply: false` buys nothing and returns the same shape with empty results, so a
 * caller can report the plan without spending.
 */
export async function measureGridVolume(
  db: PrismaClient,
  input: {
    projectId: string;
    siteId: string | null;
    monthStart: Date;
    languageCode: string;
    locationCode: number;
    apply: boolean;
    /** Stop before spending more than this. */
    capMicros?: number;
    collect?: typeof collectKeywordMetrics;
  }
): Promise<{ plan: VolumePlan; result: VolumeResult }> {
  const plan = await planVolumeMeasurement(db, input);
  const result: VolumeResult = {
    measured: [],
    unmeasured: [],
    truncations: { count: 0, queries: [] },
    spentMicros: 0,
    batches: 0,
  };
  if (!input.apply) return { plan, result };

  const collect = input.collect ?? collectKeywordMetrics;
  const capMicros = input.capMicros ?? Number.POSITIVE_INFINITY;
  const asked = new Set<string>();

  for (let index = 0; index < plan.batches.length; index += 1) {
    const batch = plan.batches[index];
    if (result.spentMicros + batch.estimatedMicros > capMicros) {
      const remaining = plan.batches.slice(index).flatMap((row) => row.queries);
      result.truncations = { count: remaining.length, queries: remaining };
      result.error = "the volume cap was reached before every query was measured";
      break;
    }
    try {
      const output = await collect(db as never, {
        projectId: input.projectId,
        siteId: input.siteId,
        queries: batch.queries,
        languageCode: input.languageCode,
        locationCode: input.locationCode,
      });
      result.spentMicros += output.spentMicros;
      result.batches += 1;
      for (const row of output.evidence) {
        const dims = (row.dimensions ?? {}) as { query?: string };
        const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
        const query = typeof dims.query === "string" ? dims.query : "";
        if (!query) continue;
        asked.add(query.toLowerCase());
        const volume = metrics["provider:volume"]?.value;
        if (typeof volume === "number" && volume > 0) result.measured.push({ query, volume });
      }
    } catch (error) {
      // The provider refused (budget, credentials, outage). Every batch from this
      // one on was never sent, and saying nothing about them would present an
      // incomplete measurement as a complete one.
      const remaining = plan.batches.slice(index).flatMap((row) => row.queries);
      result.truncations = { count: remaining.length, queries: remaining };
      result.error = error instanceof Error ? error.message.slice(0, 200) : "the provider call failed";
      break;
    }
  }

  // A query that was sent but came back without a volume is "not measured". A
  // query that was never sent because the cap stopped the run is a truncation,
  // and saying the two are the same would hide the cap.
  const measuredKeys = new Set(result.measured.map((row) => row.query.toLowerCase()));
  for (const query of plan.toMeasure) {
    const key = query.toLowerCase();
    if (measuredKeys.has(key)) continue;
    if (result.truncations.queries.some((row) => row.toLowerCase() === key)) continue;
    if (!asked.has(key)) continue;
    result.unmeasured.push(query);
  }

  return { plan, result };
}
