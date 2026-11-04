import type { PrismaClient } from "@prisma/client";

import {
  performanceWindowEndingAt,
  type PerformanceWindow,
  type QueryPagePerformance,
} from "@/lib/funnel/performance-window";

/**
 * SQL readers for the windowed performance projection (plan P1).
 *
 * Aggregation happens in the database so a site with hundreds of thousands of
 * daily rows is not silently truncated by a row cap. Weighted position cannot be
 * expressed through Prisma's groupBy (it needs position × impressions), so these
 * are raw statements; the pure arithmetic they mirror is unit-tested in
 * `performance-window.ts`.
 */

export type PerformanceDb = Pick<PrismaClient, "$queryRaw" | "keyword" | "page">;

type QueryPageRow = {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  weighted_position: number | null;
  observations: number;
  segments: number;
  first_date: Date;
  last_date: Date;
};

type PageRow = Omit<QueryPageRow, "query">;

function toPerformance(row: QueryPageRow): QueryPagePerformance {
  return {
    query: row.query,
    url: row.page,
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
    ctr: Number(row.impressions) > 0 ? Number(row.clicks) / Number(row.impressions) : 0,
    position:
      Number(row.impressions) > 0 && row.weighted_position != null
        ? Number(row.weighted_position) / Number(row.impressions)
        : null,
    observations: Number(row.observations),
    segments: Number(row.segments),
    firstDate: row.first_date,
    lastDate: row.last_date,
  };
}

/** The latest day that has stored query data, so a lagging export is not read as zero. */
export async function latestKeywordDate(db: PerformanceDb, siteId: string): Promise<Date | null> {
  const row = await db.keyword.findFirst({
    where: { siteId },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  return row?.date ?? null;
}

export async function latestPageDate(db: PerformanceDb, siteId: string): Promise<Date | null> {
  const row = await db.page.findFirst({
    where: { siteId },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  return row?.date ?? null;
}

export async function readQueryPagePerformance(
  db: PerformanceDb,
  siteId: string,
  window: PerformanceWindow
): Promise<QueryPagePerformance[]> {
  const rows = await db.$queryRaw<QueryPageRow[]>`
    SELECT
      "query" AS query,
      "page" AS page,
      SUM("clicks")::float8 AS clicks,
      SUM("impressions")::float8 AS impressions,
      SUM("position" * "impressions")::float8 AS weighted_position,
      COUNT(*)::int AS observations,
      COUNT(DISTINCT "device" || '|' || "country")::int AS segments,
      MIN("date") AS first_date,
      MAX("date") AS last_date
    FROM "Keyword"
    WHERE "siteId" = ${siteId}
      AND "date" >= ${window.start}
      AND "date" < ${window.endExclusive}
      AND "query" <> ''
      AND "page" <> ''
    GROUP BY "query", "page"
  `;
  return rows.map(toPerformance);
}

export async function readPagePerformance(
  db: PerformanceDb,
  siteId: string,
  window: PerformanceWindow
): Promise<QueryPagePerformance[]> {
  const rows = await db.$queryRaw<PageRow[]>`
    SELECT
      "url" AS page,
      SUM("clicks")::float8 AS clicks,
      SUM("impressions")::float8 AS impressions,
      SUM("position" * "impressions")::float8 AS weighted_position,
      COUNT(*)::int AS observations,
      COUNT(DISTINCT "device" || '|' || "country")::int AS segments,
      MIN("date") AS first_date,
      MAX("date") AS last_date
    FROM "Page"
    WHERE "siteId" = ${siteId}
      AND "date" >= ${window.start}
      AND "date" < ${window.endExclusive}
      AND "url" <> ''
    GROUP BY "url"
  `;
  return rows.map((row) => toPerformance({ ...row, query: "" }));
}

/** Convenience: the current window for a site, or null when it has no data. */
export async function currentPerformanceWindow(
  db: PerformanceDb,
  siteId: string,
  days?: number
): Promise<PerformanceWindow | null> {
  const latest = await latestKeywordDate(db, siteId);
  return latest ? performanceWindowEndingAt(latest, days) : null;
}
