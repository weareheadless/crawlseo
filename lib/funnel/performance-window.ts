/**
 * Query/page performance over an explicit window (plan P1).
 *
 * The funnel used to project ranking evidence from "the latest 400 Keyword rows",
 * which are split by day, device and country. That produced one observation per
 * query/page — often a single impression — and dropped every other day of the
 * window. On one tenant, 986 queries were observed in 28 days and only 238 reached
 * the board, and a query with 269 impressions and 10 clicks was represented by a
 * one-impression row.
 *
 * Everything here works on a declared window and aggregates disjoint rows. It is
 * pure so the arithmetic can be tested without a database; the reader in
 * `gsc-performance.ts` returns the same shape from SQL.
 */

export const PERFORMANCE_WINDOW_DAYS = 28;

export type PerformanceRow = {
  query: string;
  page: string;
  date: Date;
  clicks: number;
  impressions: number;
  position: number;
  /** Present in the source data; retained so the caller can declare the scope. */
  device?: string | null;
  country?: string | null;
};

export type PerformanceWindow = {
  /** Inclusive first day. */
  start: Date;
  /** Inclusive last day. */
  end: Date;
  /** Exclusive upper bound for half-open SQL comparisons. */
  endExclusive: Date;
  days: number;
};

/** The UTC day of a timestamp, so a stored 05:00 offset does not shift the date. */
export function utcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/**
 * A window ending on the latest date that actually has data.
 *
 * Using the wall clock instead would report a partial window as complete whenever
 * Google's export lags a day or two, which is the normal case.
 */
export function performanceWindowEndingAt(latest: Date, days = PERFORMANCE_WINDOW_DAYS): PerformanceWindow {
  const end = utcDay(latest);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const endExclusive = new Date(end.getTime() + 86_400_000);
  return { start, end, endExclusive, days };
}

export function isInWindow(date: Date, window: PerformanceWindow): boolean {
  const day = utcDay(date).getTime();
  return day >= window.start.getTime() && day <= window.end.getTime();
}

export type QueryPagePerformance = {
  query: string;
  url: string;
  clicks: number;
  impressions: number;
  /** clicks / impressions; 0 when there were no impressions. */
  ctr: number;
  /**
   * Impression-weighted average position, or null when there were no impressions.
   * Zero impressions is "no observed rank", never position 0.
   */
  position: number | null;
  /** Source rows that contributed. */
  observations: number;
  /** Distinct device/country segments aggregated into this row. */
  segments: number;
  firstDate: Date;
  lastDate: Date;
};

type Accumulator = {
  query: string;
  url: string;
  clicks: number;
  impressions: number;
  weightedPosition: number;
  observations: number;
  segments: Set<string>;
  firstDate: Date;
  lastDate: Date;
};

function accumulate(
  target: Map<string, Accumulator>,
  key: string,
  seed: () => Accumulator,
  row: { clicks: number; impressions: number; position: number; date: Date; device?: string | null; country?: string | null }
): void {
  const current = target.get(key) ?? seed();
  current.clicks += row.clicks;
  current.impressions += row.impressions;
  current.weightedPosition += row.position * row.impressions;
  current.observations += 1;
  current.segments.add(`${row.device ?? ""}|${row.country ?? ""}`);
  if (row.date < current.firstDate) current.firstDate = row.date;
  if (row.date > current.lastDate) current.lastDate = row.date;
  target.set(key, current);
}

function finish(acc: Accumulator): QueryPagePerformance {
  return {
    query: acc.query,
    url: acc.url,
    clicks: acc.clicks,
    impressions: acc.impressions,
    ctr: acc.impressions > 0 ? acc.clicks / acc.impressions : 0,
    position: acc.impressions > 0 ? acc.weightedPosition / acc.impressions : null,
    observations: acc.observations,
    segments: acc.segments.size,
    firstDate: acc.firstDate,
    lastDate: acc.lastDate,
  };
}

/**
 * Aggregate query/page rows inside the window.
 *
 * Sums are additive; CTR is recomputed from the sums rather than averaged, and
 * position is weighted by impressions, because an average of daily positions
 * weights a one-impression day the same as a two-hundred-impression day.
 */
export function aggregateQueryPagePerformance(
  rows: PerformanceRow[],
  window: PerformanceWindow
): QueryPagePerformance[] {
  const byQueryPage = new Map<string, Accumulator>();
  for (const row of rows) {
    if (!row.query || !isInWindow(row.date, window)) continue;
    const key = `${row.query}\u0000${row.page}`;
    accumulate(byQueryPage, key, () => ({
      query: row.query,
      url: row.page,
      clicks: 0,
      impressions: 0,
      weightedPosition: 0,
      observations: 0,
      segments: new Set<string>(),
      firstDate: row.date,
      lastDate: row.date,
    }), row);
  }
  return [...byQueryPage.values()].map(finish);
}

/**
 * Page-only totals. Search Console query rows are privacy-limited and do not sum
 * to the page total, so the two are separate observations rather than a
 * reconciliation of each other.
 */
export function aggregatePagePerformance(
  rows: PerformanceRow[],
  window: PerformanceWindow
): QueryPagePerformance[] {
  const byPage = new Map<string, Accumulator>();
  for (const row of rows) {
    if (!row.page || !isInWindow(row.date, window)) continue;
    accumulate(byPage, row.page, () => ({
      query: "",
      url: row.page,
      clicks: 0,
      impressions: 0,
      weightedPosition: 0,
      observations: 0,
      segments: new Set<string>(),
      firstDate: row.date,
      lastDate: row.date,
    }), row);
  }
  return [...byPage.values()].map(finish);
}

/**
 * A comparison window of the same length immediately before the current one.
 * Overlap is impossible by construction; unequal coverage is the caller's to
 * report, not to hide.
 */
export function previousWindow(window: PerformanceWindow): PerformanceWindow {
  const end = new Date(window.start.getTime() - 86_400_000);
  const start = new Date(end.getTime() - (window.days - 1) * 86_400_000);
  return { start, end, endExclusive: window.start, days: window.days };
}
