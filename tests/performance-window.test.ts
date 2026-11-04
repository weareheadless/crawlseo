import { describe, expect, it } from "vitest";

import {
  aggregatePagePerformance,
  aggregateQueryPagePerformance,
  isInWindow,
  performanceWindowEndingAt,
  previousWindow,
  type PerformanceRow,
} from "@/lib/funnel/performance-window";

/**
 * The board used to be built from "the latest 400 Keyword rows", one observation
 * per query/page. Those rows are split by day, device and country, so a query with
 * 269 impressions over 28 days reached detection as a single one-impression row.
 */
const day = (iso: string) => new Date(`${iso}T05:00:00.000Z`);

const row = (over: Omit<Partial<PerformanceRow>, "date"> & { date: string }): PerformanceRow => ({
  query: "puerto morelos condos for sale",
  page: "https://site.test/puerto-morelos",
  clicks: 0,
  impressions: 10,
  position: 12,
  device: "DESKTOP",
  country: "usa",
  ...over,
  date: day(over.date),
});

describe("performance window", () => {
  const window = performanceWindowEndingAt(day("2026-10-31"), 28);

  it("anchors to the latest day that has data, not the wall clock", () => {
    expect(window.end.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(window.start.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(window.days).toBe(28);
  });

  it("covers 28 days inclusive", () => {
    expect(isInWindow(day("2026-10-04"), window)).toBe(true);
    expect(isInWindow(day("2026-10-31"), window)).toBe(true);
    expect(isInWindow(day("2026-10-03"), window)).toBe(false);
    expect(isInWindow(day("2026-11-01"), window)).toBe(false);
  });

  it("puts the comparison window immediately before, with no overlap", () => {
    const previous = previousWindow(window);
    expect(previous.end.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(previous.start.toISOString()).toBe("2026-09-06T00:00:00.000Z");
    expect(isInWindow(previous.end, window)).toBe(false);
  });
});

describe("query/page aggregation", () => {
  const window = performanceWindowEndingAt(day("2026-10-31"), 28);

  it("sums every day of the window into one observation", () => {
    const rows = [
      row({ date: "2026-10-10", impressions: 100, clicks: 4, position: 12 }),
      row({ date: "2026-10-20", impressions: 150, clicks: 5, position: 13 }),
      row({ date: "2026-10-31", impressions: 19, clicks: 1, position: 14 }),
    ];
    const [result] = aggregateQueryPagePerformance(rows, window);
    expect(result.impressions).toBe(269);
    expect(result.clicks).toBe(10);
    expect(result.observations).toBe(3);
    expect(result.ctr).toBeCloseTo(10 / 269, 6);
  });

  it("weights position by impressions so a quiet day cannot dominate", () => {
    const rows = [
      row({ date: "2026-10-10", impressions: 1000, position: 6 }),
      row({ date: "2026-10-11", impressions: 1, position: 60 }),
    ];
    const [result] = aggregateQueryPagePerformance(rows, window);
    // Not (6 + 60) / 2 = 33.
    expect(result.position).toBeCloseTo((1000 * 6 + 1 * 60) / 1001, 6);
  });

  it("reports no position when nothing was observed", () => {
    const [result] = aggregateQueryPagePerformance([row({ date: "2026-10-10", impressions: 0, clicks: 0 })], window);
    expect(result.position).toBeNull();
    expect(result.ctr).toBe(0);
  });

  it("ignores rows outside the window", () => {
    const rows = [row({ date: "2026-10-10", impressions: 10 }), row({ date: "2026-09-01", impressions: 999 })];
    expect(aggregateQueryPagePerformance(rows, window)[0].impressions).toBe(10);
  });

  it("is order-independent and aggregates device/country segments without losing them", () => {
    const rows = [
      row({ date: "2026-10-10", device: "MOBILE", country: "usa", impressions: 10, clicks: 1, position: 8 }),
      row({ date: "2026-10-10", device: "DESKTOP", country: "usa", impressions: 30, clicks: 3, position: 10 }),
      row({ date: "2026-10-11", device: "DESKTOP", country: "mex", impressions: 60, clicks: 6, position: 12 }),
    ];
    const forward = aggregateQueryPagePerformance(rows, window)[0];
    const reversed = aggregateQueryPagePerformance([...rows].reverse(), window)[0];
    expect(forward).toEqual(reversed);
    expect(forward.impressions).toBe(100);
    expect(forward.clicks).toBe(10);
    expect(forward.segments).toBe(3);
  });

  it("keeps distinct queries and pages apart", () => {
    const rows = [
      row({ date: "2026-10-10", query: "a", page: "https://site.test/a" }),
      row({ date: "2026-10-10", query: "a", page: "https://site.test/b" }),
      row({ date: "2026-10-10", query: "b", page: "https://site.test/a" }),
    ];
    expect(aggregateQueryPagePerformance(rows, window)).toHaveLength(3);
  });

  it("sums page totals independently of the query rows", () => {
    const rows = [
      row({ date: "2026-10-10", query: "one", impressions: 10 }),
      row({ date: "2026-10-10", query: "two", impressions: 20 }),
    ];
    const [page] = aggregatePagePerformance(rows, window);
    expect(page.impressions).toBe(30);
    expect(page.query).toBe("");
  });
});
