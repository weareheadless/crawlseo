import { describe, expect, it } from "vitest";

import {
  MIN_WEEK_IMPRESSIONS,
  bucketWeekly,
  buildRankChart,
  combineWeeklySeries,
  isoWeekStart,
} from "@/lib/funnel/rank-series";

/**
 * CMP-004's chart maths.
 *
 * The acceptance requires a weekly value to equal the impressions-weighted mean of
 * that week's daily rows, checked against a hand-computed fixture — so the first
 * test is arithmetic done by hand, not by the code under test.
 */
describe("CMP-004 weekly bucketing", () => {
  it("buckets to the Monday that starts the ISO week, UTC", () => {
    // 2026-11-23 is a Monday; its week starts on itself.
    expect(isoWeekStart(new Date("2026-11-23T00:00:00Z"))).toBe("2026-11-23");
    expect(isoWeekStart(new Date("2026-11-24T00:00:00Z"))).toBe("2026-11-23");
    // Sunday belongs to the week that began six days earlier.
    expect(isoWeekStart(new Date("2026-11-29T00:00:00Z"))).toBe("2026-11-23");
    // And the next Monday opens a new week.
    expect(isoWeekStart(new Date("2026-11-30T00:00:00Z"))).toBe("2026-11-30");
    // Across a month boundary.
    expect(isoWeekStart(new Date("2026-12-01T00:00:00Z"))).toBe("2026-11-30");
  });

  it("weights a week by impressions, hand-computed", () => {
    // Week of 2026-11-23, three days:
    //   day 1: position 10 on 100 impressions → 1000
    //   day 2: position 20 on 300 impressions → 6000
    //   day 3: position 30 on 100 impressions → 3000
    // sum 10,000 / 500 impressions = 20.0
    const points = bucketWeekly(
      [
        { date: new Date("2026-11-23T00:00:00Z"), position: 10, impressions: 100, clicks: 2 },
        { date: new Date("2026-11-24T00:00:00Z"), position: 20, impressions: 300, clicks: 5 },
        { date: new Date("2026-11-25T00:00:00Z"), position: 30, impressions: 100, clicks: 1 },
      ],
      { floor: 1 }
    );
    expect(points.points).toHaveLength(1);
    expect(points.points[0]).toMatchObject({
      week: "2026-11-23",
      position: 20,
      impressions: 500,
      clicks: 8,
      days: 3,
    });
  });

  it("counts a second week separately, not as a running average", () => {
    const points = bucketWeekly(
      [
        { date: new Date("2026-11-23T00:00:00Z"), position: 10, impressions: 100, clicks: 0 },
        { date: new Date("2026-11-30T00:00:00Z"), position: 4, impressions: 100, clicks: 0 },
      ],
      { floor: 1 }
    );
    expect(points.points.map((point) => point.position)).toEqual([10, 4]);
  });

  it("suppresses a week below the impression floor instead of plotting it", () => {
    // A position observed on 3 impressions is not the same claim as one on 900.
    const points = bucketWeekly([
      { date: new Date("2026-11-23T00:00:00Z"), position: 3, impressions: 3, clicks: 0 },
    ]);
    expect(points.points).toHaveLength(0);
    expect(points.suppressed).toEqual([{ week: "2026-11-23", impressions: 3 }]);
  });

  it("plots a week exactly at the floor", () => {
    const points = bucketWeekly([
      { date: new Date("2026-11-23T00:00:00Z"), position: 3, impressions: MIN_WEEK_IMPRESSIONS, clicks: 0 },
    ]);
    expect(points.points).toHaveLength(1);
  });

  it("ignores a row with no usable position", () => {
    const points = bucketWeekly(
      [
        { date: new Date("2026-11-23T00:00:00Z"), position: 0, impressions: 900, clicks: 0 },
        { date: new Date("2026-11-24T00:00:00Z"), position: Number.NaN, impressions: 900, clicks: 0 },
        { date: new Date("2026-11-25T00:00:00Z"), position: 7, impressions: 100, clicks: 0 },
      ],
      { floor: 1 }
    );
    expect(points.points).toHaveLength(1);
    expect(points.points[0].position).toBe(7);
    expect(points.points[0].days).toBe(1);
  });

  it("is deterministic: the same rows produce identical values", () => {
    const rows = [
      { date: new Date("2026-11-23T00:00:00Z"), position: 9.6666, impressions: 3, clicks: 0 },
      { date: new Date("2026-11-24T00:00:00Z"), position: 4.1111, impressions: 7, clicks: 0 },
    ];
    const first = bucketWeekly(rows, { floor: 1 });
    const second = bucketWeekly([...rows].reverse(), { floor: 1 });
    expect(first.points).toEqual(second.points);
  });
});

describe("CMP-004 cluster series", () => {
  it("weights a combined week by impressions, not by average of averages", () => {
    // Query A: position 2 on 900 impressions.  Query B: position 20 on 100.
    // 1800 + 2000 = 3800 / 1000 = 3.8.  An average of averages would say 11.
    const combined = combineWeeklySeries([
      { query: "a", points: [{ week: "2026-11-23", position: 2, impressions: 900, clicks: 1, days: 5 }], suppressed: [] },
      { query: "b", points: [{ week: "2026-11-23", position: 20, impressions: 100, clicks: 0, days: 2 }], suppressed: [] },
    ]);
    expect(combined.points).toHaveLength(1);
    expect(combined.points[0].position).toBe(3.8);
    expect(combined.points[0].impressions).toBe(1000);
  });

  it("does not let a quiet query move the cluster as much as a loud one", () => {
    const loud = combineWeeklySeries([
      { query: "a", points: [{ week: "2026-11-23", position: 4, impressions: 10_000, clicks: 0, days: 7 }], suppressed: [] },
      { query: "b", points: [{ week: "2026-11-23", position: 40, impressions: 10, clicks: 0, days: 1 }], suppressed: [] },
    ]);
    expect(loud.points[0].position).toBeCloseTo(4.04, 2);
  });
});

describe("CMP-004 chart states", () => {
  it("says empty rather than drawing a flat line with nothing in it", () => {
    expect(buildRankChart({ weekly: [], sampled: [] }).state).toBe("empty");
  });

  it("says one_week rather than drawing a single point as a trend", () => {
    const chart = buildRankChart({
      weekly: [{ week: "2026-11-23", position: 9, impressions: 400, clicks: 3, days: 4 }],
      sampled: [],
    });
    expect(chart.state).toBe("one_week");
  });

  it("is a trend from two weekly buckets on", () => {
    const chart = buildRankChart({
      weekly: [
        { week: "2026-11-30", position: 7, impressions: 400, clicks: 3, days: 4 },
        { week: "2026-11-23", position: 9, impressions: 400, clicks: 3, days: 4 },
      ],
      sampled: [],
    });
    expect(chart.state).toBe("trend");
    // Sorted by week, so a chart never draws time backwards.
    expect(chart.weekly.map((point) => point.week)).toEqual(["2026-11-23", "2026-11-30"]);
  });

  it("keeps the sampled series separate from the weekly one", () => {
    const chart = buildRankChart({
      weekly: [
        { week: "2026-11-23", position: 9, impressions: 400, clicks: 3, days: 4 },
        { week: "2026-11-30", position: 7, impressions: 400, clicks: 3, days: 4 },
      ],
      sampled: [{ date: "2026-11-26", position: 6, query: "a query" }],
    });
    expect(chart.weekly.map((point) => point.week)).toEqual(["2026-11-23", "2026-11-30"]);
    expect(chart.sampled).toEqual([{ date: "2026-11-26", position: 6, query: "a query" }]);
    // A sampled point never becomes a weekly bucket.
    expect(chart.weekly).toHaveLength(2);
  });

  it("carries the suppressed weeks through so the chart can report them", () => {
    const chart = buildRankChart({
      weekly: [{ week: "2026-11-30", position: 7, impressions: 400, clicks: 3, days: 4 }],
      sampled: [],
      suppressed: [{ week: "2026-11-23", impressions: 2 }],
    });
    expect(chart.suppressed).toEqual([{ week: "2026-11-23", impressions: 2 }]);
  });
});
