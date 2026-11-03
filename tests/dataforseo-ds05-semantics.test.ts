import { describe, expect, it, vi } from "vitest";

import {
  METRICS,
  buildRankHistory,
  declaredState,
  labelCollisions,
  stateForAge,
} from "@/lib/funnel/metric-semantics";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("DS-05 metric semantics", () => {
  it("declares source, unit, label and caveat for every metric", () => {
    for (const metric of Object.values(METRICS)) {
      expect(metric.source).toBeTruthy();
      expect(metric.unit).toBeTruthy();
      expect(metric.label.length).toBeGreaterThan(2);
      expect(metric.caveat.length).toBeGreaterThan(20);
    }
  });

  it("never lets two metrics share a label with different semantics", () => {
    expect(labelCollisions()).toEqual([]);
    const collision = labelCollisions({
      a: { semantic: "gsc_clicks", source: "gsc", unit: "clicks", label: "Clicks", caveat: "x" },
      b: { semantic: "gsc_impressions", source: "gsc", unit: "impressions", label: "Clicks", caveat: "y" },
    });
    expect(collision).toHaveLength(1);
  });

  it("keeps GSC average position and sampled SERP rank as separate series", () => {
    const history = buildRankHistory({
      gsc: [{ date: day("2026-11-01"), position: 12, clicks: 3, impressions: 100 }],
      sampled: [{ date: day("2026-11-01"), position: 4, clicks: 0, impressions: 0 }],
    });
    expect(history.mixed).toBe(true);
    expect(history.series).toEqual(["gsc_average", "serp_sampled"]);
    expect(history.points).toHaveLength(2);
    const gsc = history.points.find((point) => point.series === "gsc_average")!;
    const sampled = history.points.find((point) => point.series === "serp_sampled")!;
    // The old overlay replaced the GSC row with the snapshot; now both survive.
    expect(gsc.position).toBe(12);
    expect(gsc.semantic).toBe("gsc_average_position");
    expect(sampled.position).toBe(4);
    expect(sampled.semantic).toBe("serp_sampled_rank");
  });

  it("still aggregates multiple GSC rows per date by impressions", () => {
    const history = buildRankHistory({
      gsc: [
        { date: day("2026-11-01"), position: 10, clicks: 1, impressions: 100 },
        { date: day("2026-11-01"), position: 20, clicks: 2, impressions: 300 },
      ],
      sampled: [],
    });
    expect(history.points).toHaveLength(1);
    expect(history.points[0].impressions).toBe(400);
    expect(history.points[0].clicks).toBe(3);
    expect(history.points[0].position).toBeCloseTo(17.5);
    expect(history.mixed).toBe(false);
  });

  it("reports a single series when only one source exists", () => {
    const history = buildRankHistory({ gsc: [], sampled: [{ date: day("2026-11-02"), position: 6, clicks: 0, impressions: 0 }] });
    expect(history.series).toEqual(["serp_sampled"]);
    expect(history.mixed).toBe(false);
  });

  it("marks stale data instead of pretending it is fresh", () => {
    const now = new Date("2026-11-03T00:00:00.000Z");
    expect(stateForAge(day("2026-11-02"), { maxAgeHours: 48, now })).toBe("fresh");
    expect(stateForAge(day("2026-10-01"), { maxAgeHours: 48, now })).toBe("stale");
    expect(stateForAge(new Date("nope"), { maxAgeHours: 48, now })).toBe("unknown");
  });

  it("declares the honest state per source", () => {
    expect(declaredState("serp_sampled_rank")).toBe("sampled");
    expect(declaredState("provider_volume")).toBe("estimated");
    expect(declaredState("field_vital")).toBe("stale");
    expect(declaredState("gsc_clicks")).toBe("fresh");
  });
});
