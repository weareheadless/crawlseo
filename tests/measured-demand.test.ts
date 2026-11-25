import { describe, expect, it } from "vitest";

import { clusterMetrics, type DemandQuery } from "@/lib/research/topic-map";

/**
 * "Zero impressions" has two meanings and the board was treating them as one.
 *
 * A query with a Search Console row and no impressions was measured: the site
 * appears in results for it and earns nothing. A query known only from provider
 * volume was never measured at all. Both reached the drafting model as
 * `impressions: 0`, so a site with no Search Console data produced proposals
 * reading "zero impressions, null position" — describing a site state nobody had
 * observed. Measured on astridrincon 2026-11-25: 0 rank rows, 160 queries, every
 * proposal written as though the site were invisible rather than unmeasured.
 */

function query(overrides: Partial<DemandQuery> & { query: string }): DemandQuery {
  return {
    impressions: 0,
    clicks: 0,
    position: null,
    volume: null,
    difficulty: null,
    observedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

describe("measured versus unmeasured demand", () => {
  it("counts only queries with a Search Console row as measured", () => {
    const metrics = clusterMetrics([
      query({ query: "balayage playa del carmen", impressions: 4, position: 12, measured: true }),
      query({ query: "balayage", volume: 272300, measured: false }),
    ]);
    expect(metrics.measuredQueries).toBe(1);
  });

  it("reports a cluster with no Search Console rows as wholly unmeasured", () => {
    const metrics = clusterMetrics([
      query({ query: "balayage", volume: 272300, measured: false }),
      query({ query: "color de cabello", volume: 40860, measured: false }),
    ]);
    expect(metrics.measuredQueries).toBe(0);
    expect(metrics.impressions).toBe(0);
    // The volume is still real: unmeasured is not the same as no demand.
    expect(metrics.volume).toBeGreaterThan(0);
  });

  it("keeps the measured flag on the query the drafting call receives", () => {
    // The payload is built from `cluster.queries`, so the flag has to survive on
    // the query itself rather than only in the cluster totals.
    const queries = [
      query({ query: "balayage", volume: 272300, measured: false }),
      query({ query: "balayage playa del carmen", impressions: 3, position: 18, measured: true }),
    ];
    const metrics = clusterMetrics(queries);
    expect(metrics.measuredQueries).toBe(1);
    expect(queries.map((entry) => entry.measured)).toEqual([false, true]);
  });
});
