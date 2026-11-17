import { db } from "@/lib/db";
import { calculatePercentChange, getDateRange } from "@/lib/date-utils";

export type PeriodMetrics = {
  clicks: number;
  impressions: number;
  avgPosition: number;
  avgCtr: number;
  uniqueKeywords: number;
};

export type KeywordRow = {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
  ctr: number;
};

export type PageRow = {
  url: string;
  clicks: number;
  impressions: number;
  position: number;
  ctr: number;
};

export type DailyTraffic = {
  date: string;
  clicks: number;
  impressions: number;
};

export type SeoMetricsDateRange = {
  start: Date;
  end: Date;
};

function parseRange(days: number) {
  const { start, end } = getDateRange(days);
  return {
    start: new Date(`${start}T00:00:00.000Z`),
    end: new Date(`${end}T23:59:59.999Z`),
  };
}

function previousRange(days: number) {
  const current = parseRange(days);
  const start = new Date(current.start);
  start.setUTCDate(start.getUTCDate() - days);
  const end = new Date(current.start);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return { start, end };
}

function previousDateRange(current: SeoMetricsDateRange): SeoMetricsDateRange {
  const duration = current.end.getTime() - current.start.getTime();
  const end = new Date(current.start.getTime() - 1);
  return { start: new Date(end.getTime() - duration), end };
}

export function seoMetricsDateRange(startDate: string, endDate: string): SeoMetricsDateRange {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T23:59:59.999Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new Error("SEO metrics date range is invalid");
  }
  return { start, end };
}

/**
 * One window of totals, computed by Postgres.
 *
 * These functions used to stream every Page and Keyword row for the window into
 * Node and sum them there. A 90-day view of a mid-size site is tens of thousands
 * of rows per call, and the portfolio dashboard did it once per site, twice
 * (current and previous window). That load is what made navigation feel like a
 * download and what pushed the host into swap. SQL returns one row instead.
 *
 * Semantics are preserved exactly:
 * - headline traffic comes from Page rows when they exist (they carry the full
 *   site totals, query rows omit anonymised searches), otherwise Keyword rows;
 * - average position is impression-weighted, falling back to a plain average
 *   when no row has impressions;
 * - uniqueKeywords always counts distinct queries from Keyword rows.
 */
type WindowTotals = {
  clicks: number;
  impressions: number;
  weighted: number;
  weight: number;
  plain: number;
  row_count: number;
  unique_keywords: number;
};

async function windowTotals(
  siteId: string,
  range: SeoMetricsDateRange
): Promise<{ page: WindowTotals; keyword: WindowTotals }> {
  const [row] = await db.$queryRaw<Array<{
    page_clicks: number; page_impressions: number; page_weighted: number;
    page_weight: number; page_plain: number; page_rows: number;
    keyword_clicks: number; keyword_impressions: number; keyword_weighted: number;
    keyword_weight: number; keyword_plain: number; keyword_rows: number;
    unique_keywords: number;
  }>>`
    WITH page_totals AS (
      SELECT
        COALESCE(SUM("clicks"), 0)::float8 AS clicks,
        COALESCE(SUM("impressions"), 0)::float8 AS impressions,
        COALESCE(SUM("position" * GREATEST("impressions", 0)), 0)::float8 AS weighted,
        COALESCE(SUM(GREATEST("impressions", 0)), 0)::float8 AS weight,
        COALESCE(AVG("position"), 0)::float8 AS plain,
        COUNT(*)::int AS row_count
      FROM "Page"
      WHERE "siteId" = ${siteId}
        AND "date" >= (${range.start}::timestamptz AT TIME ZONE 'UTC')
        AND "date" <= (${range.end}::timestamptz AT TIME ZONE 'UTC')
    ),
    keyword_totals AS (
      SELECT
        COALESCE(SUM("clicks"), 0)::float8 AS clicks,
        COALESCE(SUM("impressions"), 0)::float8 AS impressions,
        COALESCE(SUM("position" * GREATEST("impressions", 0)), 0)::float8 AS weighted,
        COALESCE(SUM(GREATEST("impressions", 0)), 0)::float8 AS weight,
        COALESCE(AVG("position"), 0)::float8 AS plain,
        COUNT(*)::int AS row_count,
        COUNT(DISTINCT NULLIF("query", ''))::int AS unique_queries
      FROM "Keyword"
      WHERE "siteId" = ${siteId}
        AND "date" >= (${range.start}::timestamptz AT TIME ZONE 'UTC')
        AND "date" <= (${range.end}::timestamptz AT TIME ZONE 'UTC')
    )
    SELECT
      p.clicks AS page_clicks,
      p.impressions AS page_impressions,
      p.weighted AS page_weighted,
      p.weight AS page_weight,
      p.plain AS page_plain,
      p.row_count AS page_rows,
      k.clicks AS keyword_clicks,
      k.impressions AS keyword_impressions,
      k.weighted AS keyword_weighted,
      k.weight AS keyword_weight,
      k.plain AS keyword_plain,
      k.row_count AS keyword_rows,
      COALESCE(k.unique_queries, 0) AS unique_keywords
    FROM page_totals p, keyword_totals k
  `;

  const toTotals = (source: "page" | "keyword"): WindowTotals => ({
    clicks: row[`${source}_clicks`],
    impressions: row[`${source}_impressions`],
    weighted: row[`${source}_weighted`],
    weight: row[`${source}_weight`],
    plain: row[`${source}_plain`],
    row_count: row[`${source}_rows`],
    unique_keywords: source === "keyword" ? row.unique_keywords : 0,
  });

  return { page: toTotals("page"), keyword: toTotals("keyword") };
}

function positionOf(totals: WindowTotals): number {
  if (totals.weight > 0) return totals.weighted / totals.weight;
  // A row set with no impressions has no weight to blend by; the plain average
  // is what the previous in-JS implementation returned in that case.
  return totals.row_count > 0 ? totals.plain : 0;
}

function periodFrom(totals: WindowTotals, keywordsFrom?: WindowTotals): PeriodMetrics {
  const impressions = totals.impressions;
  return {
    clicks: totals.clicks,
    impressions,
    avgPosition: positionOf(totals),
    avgCtr: impressions > 0 ? totals.clicks / impressions : 0,
    uniqueKeywords: keywordsFrom ? keywordsFrom.unique_keywords : totals.unique_keywords,
  };
}

export async function getSitePeriodMetrics(
  siteId: string,
  days = 28,
  dateRange?: SeoMetricsDateRange
): Promise<{
  current: PeriodMetrics;
  previous: PeriodMetrics;
  deltas: {
    clicks: number;
    impressions: number;
    avgPosition: number;
    avgCtr: number;
  };
}> {
  const currentRange = dateRange ?? parseRange(days);
  const prevRange = dateRange ? previousDateRange(dateRange) : previousRange(days);

  const [currentTotals, previousTotals] = await Promise.all([
    windowTotals(siteId, currentRange),
    windowTotals(siteId, prevRange),
  ]);

  // Page-level rows carry the complete site totals. Query-level rows omit
  // anonymised searches, so they must not be used for headline traffic.
  const current = periodFrom(
    currentTotals.page.row_count > 0 ? currentTotals.page : currentTotals.keyword,
    currentTotals.keyword
  );
  const previous = periodFrom(
    previousTotals.page.row_count > 0 ? previousTotals.page : previousTotals.keyword
  );

  return {
    current,
    previous,
    deltas: {
      clicks: calculatePercentChange(current.clicks, previous.clicks),
      impressions: calculatePercentChange(
        current.impressions,
        previous.impressions
      ),
      // Positive delta = improved (lower position is better)
      avgPosition: previous.avgPosition - current.avgPosition,
      avgCtr: calculatePercentChange(current.avgCtr, previous.avgCtr),
    },
  };
}

/**
 * Aggregate keyword rows across the period (sum metrics, weighted position).
 * Grouping happens in Postgres; only `limit` rows come back.
 */
export async function getTopKeywords(
  siteId: string,
  days = 28,
  limit = 50,
  dateRange?: SeoMetricsDateRange
): Promise<KeywordRow[]> {
  const range = dateRange ?? parseRange(days);
  const rows = await db.$queryRaw<Array<{
    query: string;
    clicks: number;
    impressions: number;
    weighted: number;
    weight: number;
  }>>`
    SELECT
      "query" AS query,
      SUM("clicks")::float8 AS clicks,
      SUM("impressions")::float8 AS impressions,
      SUM("position" * GREATEST("impressions", 1))::float8 AS weighted,
      SUM(GREATEST("impressions", 1))::float8 AS weight
    FROM "Keyword"
    WHERE "siteId" = ${siteId}
      AND "date" >= (${range.start}::timestamptz AT TIME ZONE 'UTC')
      AND "date" <= (${range.end}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY "query"
    ORDER BY SUM("clicks") DESC, SUM("impressions") DESC, "query" ASC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    query: row.query,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.weight > 0 ? row.weighted / row.weight : 0,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
  }));
}

export async function getTopPages(
  siteId: string,
  days = 28,
  limit = 50,
  dateRange?: SeoMetricsDateRange
): Promise<PageRow[]> {
  const range = dateRange ?? parseRange(days);
  const rows = await db.$queryRaw<Array<{
    url: string;
    clicks: number;
    impressions: number;
    weighted: number;
    weight: number;
  }>>`
    SELECT
      "url" AS url,
      SUM("clicks")::float8 AS clicks,
      SUM("impressions")::float8 AS impressions,
      SUM("position" * GREATEST("impressions", 1))::float8 AS weighted,
      SUM(GREATEST("impressions", 1))::float8 AS weight
    FROM "Page"
    WHERE "siteId" = ${siteId}
      AND "date" >= (${range.start}::timestamptz AT TIME ZONE 'UTC')
      AND "date" <= (${range.end}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY "url"
    ORDER BY SUM("clicks") DESC, SUM("impressions") DESC, "url" ASC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    url: row.url,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.weight > 0 ? row.weighted / row.weight : 0,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
  }));
}

export async function getDailyTraffic(
  siteId: string,
  days = 90
): Promise<DailyTraffic[]> {
  const range = parseRange(days);

  // Prefer page-level rows when present (cleaner site totals); fall back to
  // keyword rows. One grouped query per attempt instead of every raw row.
  const pages = await db.$queryRaw<DailyTraffic[]>`
    SELECT
      to_char("date", 'YYYY-MM-DD') AS date,
      SUM("clicks")::float8 AS clicks,
      SUM("impressions")::float8 AS impressions
    FROM "Page"
    WHERE "siteId" = ${siteId}
      AND "date" >= (${range.start}::timestamptz AT TIME ZONE 'UTC')
      AND "date" <= (${range.end}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  if (pages.length > 0) return pages;

  return db.$queryRaw<DailyTraffic[]>`
    SELECT
      to_char("date", 'YYYY-MM-DD') AS date,
      SUM("clicks")::float8 AS clicks,
      SUM("impressions")::float8 AS impressions
    FROM "Keyword"
    WHERE "siteId" = ${siteId}
      AND "date" >= (${range.start}::timestamptz AT TIME ZONE 'UTC')
      AND "date" <= (${range.end}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1
    ORDER BY 1 ASC
  `;
}

export function formatPosition(position: number): string {
  if (!Number.isFinite(position) || position <= 0) return "—";
  return position.toFixed(1);
}

export function formatCtr(ctr: number): string {
  return `${(ctr * 100).toFixed(2)}%`;
}

export function formatCompact(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

export function positionBand(position: number): "top3" | "top10" | "top20" | "deep" {
  if (position > 0 && position <= 3) return "top3";
  if (position <= 10) return "top10";
  if (position <= 20) return "top20";
  return "deep";
}
