import type { PrismaClient } from "@prisma/client";

/**
 * CMP-004: the rank trend we already own, read as a weekly series.
 *
 * Two facts shaped this reader.
 *
 * 1. **A daily Search Console row is not a position.** Measured on 2026-11-24, a
 *    query averages ~14 impressions per day, so one day's `position` is itself
 *    ±2 places. The |Δ| between two random halves of the same day's impressions
 *    is the noise floor; weekly movement (median 3.00 on Susi, 2.31 on Atelier)
 *    clears it, daily movement (0.40) does not.
 * 2. **We already store the history.** `Keyword` holds one row per query, day,
 *    page and device. Nothing needs buying to draw a trend; the reader buckets
 *    what is there.
 *
 * The aggregation is impressions-weighted, because a position observed on 1
 * impression is not the same claim as one observed on 900. A week that never
 * clears `MIN_WEEK_IMPRESSIONS` is reported as suppressed rather than plotted:
 * a 1-impression bucket drawn as a fact is a chart that lies.
 *
 * This is arithmetic on facts we hold. No judgement happens here.
 */

/** A week needs this many impressions before its mean position is worth drawing. */
export const MIN_WEEK_IMPRESSIONS = 10;

export type DailyRankRow = {
  date: Date;
  position: number;
  impressions: number;
  clicks: number;
};

export type WeeklyRankPoint = {
  /** ISO week start (Monday) as `YYYY-MM-DD`. The bucket's identity. */
  week: string;
  /** Impressions-weighted mean position over the week. Lower is better. */
  position: number;
  impressions: number;
  clicks: number;
  /** Days that actually had a row, so a two-day week is visible as thin. */
  days: number;
};

export type SampledRankPoint = {
  date: string;
  position: number;
  /** Which query the sample was bought for, so an aggregate can say so. */
  query: string;
};

export type WeeklyRankSeries = {
  query: string;
  points: WeeklyRankPoint[];
  /** Weeks that had data but too few impressions to be a position. */
  suppressed: Array<{ week: string; impressions: number }>;
};

export type RankChart = {
  weekly: WeeklyRankPoint[];
  sampled: SampledRankPoint[];
  suppressed: Array<{ week: string; impressions: number }>;
  /**
   * `empty` — nothing to draw. `one_week` — a single bucket, which is a point,
   * not a trend, and must not be drawn as a flat line. `trend` — two or more
   * weekly buckets.
   */
  state: "empty" | "one_week" | "trend";
};

/** The Monday that starts the ISO week containing `date`, in UTC. */
export function isoWeekStart(date: Date): string {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = new Date(utc).getUTCDay();
  // Sunday belongs to the week that started six days earlier.
  const offset = (day + 6) % 7;
  return new Date(utc - offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Bucket daily rows into ISO weeks.
 *
 * Pure, so the maths can be checked against a hand-computed fixture. Rows for
 * the same week from different pages or devices are folded together, weighted by
 * impressions — the query's position for that week, not one page's.
 */
export function bucketWeekly(
  rows: DailyRankRow[],
  opts: { floor?: number } = {}
): { points: WeeklyRankPoint[]; suppressed: Array<{ week: string; impressions: number }> } {
  const floor = opts.floor ?? MIN_WEEK_IMPRESSIONS;
  const byWeek = new Map<string, { weighted: number; impressions: number; clicks: number; days: Set<string> }>();

  for (const row of rows) {
    if (!Number.isFinite(row.position) || row.position <= 0) continue;
    const impressions = Number.isFinite(row.impressions) ? Math.max(0, row.impressions) : 0;
    const week = isoWeekStart(row.date);
    const entry = byWeek.get(week) ?? { weighted: 0, impressions: 0, clicks: 0, days: new Set<string>() };
    entry.weighted += row.position * impressions;
    entry.impressions += impressions;
    entry.clicks += Number.isFinite(row.clicks) ? Math.max(0, row.clicks) : 0;
    entry.days.add(row.date.toISOString().slice(0, 10));
    byWeek.set(week, entry);
  }

  const points: WeeklyRankPoint[] = [];
  const suppressed: Array<{ week: string; impressions: number }> = [];
  for (const [week, entry] of [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (entry.impressions <= 0) {
      // A week with rows but no impressions cannot be weighted at all; the mean
      // would be an unweighted guess dressed as a position.
      suppressed.push({ week, impressions: entry.impressions });
      continue;
    }
    if (entry.impressions < floor) {
      suppressed.push({ week, impressions: entry.impressions });
      continue;
    }
    points.push({
      week,
      // Rounded to two places: the chart does not need more, and a position
      // that looks like 9.6666667 invites a false precision.
      position: Math.round((entry.weighted / entry.impressions) * 100) / 100,
      impressions: entry.impressions,
      clicks: entry.clicks,
      days: entry.days.size,
    });
  }

  return { points, suppressed };
}

/**
 * Fold several queries into one cluster-level series.
 *
 * Cluster position means "the demand we serve as a whole", so each week is
 * weighted by the impressions of every member that cleared the floor. No member
 * is average-of-averages: a quiet query must not move the cluster as much as a
 * loud one.
 *
 * A week is only suppressed when *no* member had a plottable week: one member
 * being quiet that week is not a reason to leave a hole in the cluster's trend.
 */
export function combineWeeklySeries(series: WeeklyRankSeries[]): {
  points: WeeklyRankPoint[];
  suppressed: Array<{ week: string; impressions: number }>;
} {
  const byWeek = new Map<string, { weighted: number; impressions: number; clicks: number; days: number }>();
  const suppressed = new Map<string, number>();

  for (const one of series) {
    for (const point of one.points) {
      const entry = byWeek.get(point.week) ?? { weighted: 0, impressions: 0, clicks: 0, days: 0 };
      entry.weighted += point.position * point.impressions;
      entry.impressions += point.impressions;
      entry.clicks += point.clicks;
      entry.days = Math.max(entry.days, point.days);
      byWeek.set(point.week, entry);
    }
    // Only weeks this series could not plot are candidates for suppression. A
    // week another member did plot is present in `byWeek`, and the filter below
    // drops it from the suppressed list.
    for (const week of one.suppressed) {
      if (byWeek.has(week.week)) continue;
      suppressed.set(week.week, (suppressed.get(week.week) ?? 0) + week.impressions);
    }
  }

  const points = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, entry]) => ({
      week,
      position: entry.impressions === 0 ? 0 : Math.round((entry.weighted / entry.impressions) * 100) / 100,
      impressions: entry.impressions,
      clicks: entry.clicks,
      days: entry.days,
    }))
    .filter((point) => point.position > 0);

  return {
    points,
    suppressed: [...suppressed.entries()]
      .filter(([week]) => !byWeek.has(week))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, impressions]) => ({ week, impressions })),
  };
}

export type RankSeriesDb = Pick<PrismaClient, "keyword" | "evidenceRecord">;

/**
 * Read the free weekly series for one query. No purchase, no write.
 *
 * Re-running on unchanged data returns identical values: the reader owns no
 * state and rounds deterministically.
 */
export async function weeklyRankSeries(
  db: RankSeriesDb,
  input: { siteId: string; query: string; weeks?: number; now?: Date; floor?: number }
): Promise<WeeklyRankSeries> {
  const weeks = input.weeks ?? 26;
  const now = input.now ?? new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  since.setUTCDate(since.getUTCDate() - weeks * 7);

  const rows = await db.keyword.findMany({
    where: { siteId: input.siteId, query: input.query, date: { gte: since } },
    select: { date: true, position: true, impressions: true, clicks: true },
    orderBy: { date: "asc" },
  });
  const bucketed = bucketWeekly(rows, { floor: input.floor });
  return { query: input.query, points: bucketed.points, suppressed: bucketed.suppressed };
}

/**
 * Read the sampled SERP positions for the same queries.
 *
 * These are moments, not averages: the monthly bundle buys one SERP and the
 * result is true for that day. They are returned separately so a chart can show
 * them as labelled dots and never join them to the weekly line.
 */
export async function sampledRankSeries(
  db: RankSeriesDb,
  input: { projectId: string; queries: string[]; weeks?: number; now?: Date }
): Promise<SampledRankPoint[]> {
  if (input.queries.length === 0) return [];
  const weeks = input.weeks ?? 26;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - weeks * 7 * 86_400_000);
  const wanted = new Set(input.queries.map((query) => query.trim().toLowerCase()));

  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId: input.projectId,
      kind: "serp_snapshot",
      supersededById: null,
      observedAt: { gte: since },
    },
    select: { observedAt: true, dimensions: true, metrics: true },
    orderBy: { observedAt: "asc" },
  });

  const points: SampledRankPoint[] = [];
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as { query?: string };
    const query = typeof dims.query === "string" ? dims.query.trim().toLowerCase() : "";
    if (!query || !wanted.has(query)) continue;
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const position = metrics["provider:position"]?.value ?? null;
    // A snapshot with no position means we did not appear in that SERP. It is a
    // real observation of absence, but it is not a position, so it is not plotted
    // as one.
    if (position == null || position <= 0) continue;
    points.push({ date: row.observedAt.toISOString().slice(0, 10), position, query: dims.query as string });
  }
  return points;
}

/** Assemble the chart payload, including the honest empty and one-week states. */
export function buildRankChart(input: {
  weekly: WeeklyRankPoint[];
  sampled: SampledRankPoint[];
  suppressed?: Array<{ week: string; impressions: number }>;
}): RankChart {
  const weekly = [...input.weekly].sort((a, b) => a.week.localeCompare(b.week));
  const sampled = [...input.sampled].sort((a, b) => a.date.localeCompare(b.date));
  const state = weekly.length === 0 ? "empty" : weekly.length === 1 ? "one_week" : "trend";
  return { weekly, sampled, suppressed: input.suppressed ?? [], state };
}
