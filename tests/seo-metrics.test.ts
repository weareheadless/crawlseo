import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  page: { findMany: vi.fn() },
  keyword: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { getSitePeriodMetrics } from "@/lib/seo-metrics";
import { parseSeoTimeframe } from "@/lib/seo-timeframes";

describe("site period metrics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses complete page totals instead of anonymous-query keyword totals", async () => {
    mockDb.page.findMany
      .mockResolvedValueOnce([{ clicks: 218, impressions: 16000, position: 8.2 }])
      .mockResolvedValueOnce([{ clicks: 99, impressions: 8000, position: 9.1 }]);
    mockDb.keyword.findMany
      .mockResolvedValueOnce([
        { query: "apartments", clicks: 40, impressions: 5000, position: 8 },
        { query: "playa del carmen", clicks: 13, impressions: 4000, position: 9 },
      ])
      .mockResolvedValueOnce([]);

    const result = await getSitePeriodMetrics("site-1", 28);

    expect(result.current.clicks).toBe(218);
    expect(result.current.impressions).toBe(16000);
    expect(result.current.uniqueKeywords).toBe(2);
    expect(result.deltas.clicks).toBe(120.2);
    expect(result.deltas.impressions).toBe(100);
  });

  it("falls back to keyword rows when page rows have not been synced yet", async () => {
    mockDb.page.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.keyword.findMany
      .mockResolvedValueOnce([{ query: "one", clicks: 7, impressions: 70, position: 3 }])
      .mockResolvedValueOnce([{ query: "one", clicks: 5, impressions: 50, position: 4 }]);

    const result = await getSitePeriodMetrics("site-1", 28);

    expect(result.current.clicks).toBe(7);
    expect(result.current.impressions).toBe(70);
    expect(result.deltas.clicks).toBe(40);
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
