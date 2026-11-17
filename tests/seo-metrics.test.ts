import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { getSitePeriodMetrics } from "@/lib/seo-metrics";
import { parseSeoTimeframe } from "@/lib/seo-timeframes";

/**
 * One aggregated row per window: the shape `windowTotals` asks Postgres for.
 * The page and keyword sides are returned side by side so the caller can pick
 * the source without a second round trip.
 */
function totalsRow(input: {
  page?: { clicks?: number; impressions?: number; weighted?: number; weight?: number; plain?: number; rows?: number };
  keyword?: { clicks?: number; impressions?: number; weighted?: number; weight?: number; plain?: number; rows?: number; unique?: number };
}) {
  const page = input.page ?? {};
  const keyword = input.keyword ?? {};
  return {
    page_clicks: page.clicks ?? 0,
    page_impressions: page.impressions ?? 0,
    page_weighted: page.weighted ?? 0,
    page_weight: page.weight ?? 0,
    page_plain: page.plain ?? 0,
    page_rows: page.rows ?? 0,
    keyword_clicks: keyword.clicks ?? 0,
    keyword_impressions: keyword.impressions ?? 0,
    keyword_weighted: keyword.weighted ?? 0,
    keyword_weight: keyword.weight ?? 0,
    keyword_plain: keyword.plain ?? 0,
    keyword_rows: keyword.rows ?? 0,
    unique_keywords: keyword.unique ?? 0,
  };
}

describe("site period metrics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses complete page totals instead of anonymous-query keyword totals", async () => {
    mockDb.$queryRaw
      .mockResolvedValueOnce([
        totalsRow({
          page: { clicks: 218, impressions: 16000, weighted: 131200, weight: 16000, rows: 1 },
          keyword: { unique: 2 },
        }),
      ])
      .mockResolvedValueOnce([
        totalsRow({
          page: { clicks: 99, impressions: 8000, weighted: 72800, weight: 8000, rows: 1 },
        }),
      ]);

    const result = await getSitePeriodMetrics("site-1", 28);

    expect(result.current.clicks).toBe(218);
    expect(result.current.impressions).toBe(16000);
    expect(result.current.avgPosition).toBe(8.2);
    expect(result.current.uniqueKeywords).toBe(2);
    expect(result.deltas.clicks).toBe(120.2);
    expect(result.deltas.impressions).toBe(100);
  });

  it("falls back to keyword rows when page rows have not been synced yet", async () => {
    mockDb.$queryRaw
      .mockResolvedValueOnce([
        totalsRow({ keyword: { clicks: 7, impressions: 70, weighted: 210, weight: 70, rows: 1, unique: 1 } }),
      ])
      .mockResolvedValueOnce([
        totalsRow({ keyword: { clicks: 5, impressions: 50, weighted: 200, weight: 50, rows: 1, unique: 1 } }),
      ]);

    const result = await getSitePeriodMetrics("site-1", 28);

    expect(result.current.clicks).toBe(7);
    expect(result.current.impressions).toBe(70);
    expect(result.current.avgPosition).toBe(3);
    expect(result.deltas.clicks).toBe(40);
  });

  it("uses a plain average position when no row reports impressions", async () => {
    mockDb.$queryRaw
      .mockResolvedValueOnce([
        totalsRow({ page: { clicks: 0, impressions: 0, weighted: 0, weight: 0, plain: 12, rows: 4 } }),
      ])
      .mockResolvedValueOnce([totalsRow({})]);

    const result = await getSitePeriodMetrics("site-1", 28);

    expect(result.current.avgPosition).toBe(12);
    expect(result.current.avgCtr).toBe(0);
  });
});

describe("SEO timeframe parsing", () => {
  it("accepts supported periods and falls back to 28 days", () => {
    expect(parseSeoTimeframe("7")).toBe(7);
    expect(parseSeoTimeframe("90")).toBe(90);
    expect(parseSeoTimeframe("180")).toBe(180);
    expect(parseSeoTimeframe("13")).toBe(28);
    expect(parseSeoTimeframe(undefined)).toBe(28);
  });
});
