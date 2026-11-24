import { describe, expect, it, vi } from "vitest";

import { KEYWORD_BATCH_SIZE, measureGridVolume, planVolumeMeasurement } from "@/lib/funnel/volume-measurement";

/**
 * CMP-005's measurement pass.
 *
 * The boundaries are the test: measure only the declared grid, never buy twice in
 * a month, report a cap hit as a truncation rather than as "no data", and never
 * turn a query the provider had nothing for into a zero.
 */

const MONTH_START = new Date("2026-11-01T00:00:00Z");

type Membership = { dimensions: Record<string, unknown> };
type MetricsRow = { dimensions: Record<string, unknown> };

function mockDb(input: { memberships: Membership[]; measured?: MetricsRow[] }) {
  return {
    evidenceRecord: {
      findMany: vi.fn(async (args: { where: { kind: string } }) =>
        args.where.kind === "keyword_universe_membership" ? input.memberships : (input.measured ?? [])
      ),
    },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

const grid = (query: string, tracked = true): Membership => ({
  dimensions: tracked ? { query, cluster: "c", grid: "tracked" } : { query, cluster: "c" },
});

describe("CMP-005 volume plan", () => {
  it("measures only the declared grid, not every membership", async () => {
    const db = mockDb({ memberships: [grid("tracked one"), grid("tracked two"), grid("not tracked", false)] });
    const plan = await planVolumeMeasurement(db as never, { projectId: "p1", monthStart: MONTH_START });
    expect(plan.toMeasure).toEqual(["tracked one", "tracked two"]);
  });

  it("measures nothing when no grid was declared", async () => {
    const db = mockDb({ memberships: [grid("untracked", false)] });
    const plan = await planVolumeMeasurement(db as never, { projectId: "p1", monthStart: MONTH_START });
    expect(plan.toMeasure).toEqual([]);
    expect(plan.batches).toEqual([]);
    expect(plan.estimatedMicros).toBe(0);
  });

  it("does not buy a query already measured this month", async () => {
    const db = mockDb({
      memberships: [grid("already measured"), grid("needs measuring")],
      measured: [{ dimensions: { query: "Already Measured" } }],
    });
    const plan = await planVolumeMeasurement(db as never, { projectId: "p1", monthStart: MONTH_START });
    expect(plan.toMeasure).toEqual(["needs measuring"]);
    expect(plan.reused).toEqual(["already measured"]);
  });

  it("batches to the provider's own limit", async () => {
    const queries = Array.from({ length: KEYWORD_BATCH_SIZE * 2 + 3 }, (_, index) => `query ${index}`);
    const db = mockDb({ memberships: queries.map((query) => grid(query)) });
    const plan = await planVolumeMeasurement(db as never, { projectId: "p1", monthStart: MONTH_START });
    expect(plan.batches).toHaveLength(3);
    expect(plan.batches[0].queries).toHaveLength(KEYWORD_BATCH_SIZE);
    expect(plan.batches[2].queries).toHaveLength(3);
  });

  it("dedupes a query that appears under two clusters", async () => {
    const db = mockDb({
      memberships: [
        { dimensions: { query: "same", cluster: "a", grid: "tracked" } },
        { dimensions: { query: "Same", cluster: "b", grid: "tracked" } },
      ],
    });
    const plan = await planVolumeMeasurement(db as never, { projectId: "p1", monthStart: MONTH_START });
    expect(plan.toMeasure).toHaveLength(1);
  });

  it("buys nothing on a dry run and reports the same plan", async () => {
    const collect = vi.fn();
    const db = mockDb({ memberships: [grid("q1")] });
    const { plan, result } = await measureGridVolume(db as never, {
      projectId: "p1",
      siteId: "s1",
      monthStart: MONTH_START,
      languageCode: "en",
      locationCode: 2840,
      apply: false,
      collect,
    });
    expect(plan.toMeasure).toEqual(["q1"]);
    expect(collect).not.toHaveBeenCalled();
    expect(result.measured).toEqual([]);
    expect(result.spentMicros).toBe(0);
  });
});

describe("CMP-005 measurement honesty", () => {
  function collectReturning(rows: Array<{ query: string; volume?: number }>, spentMicros = 2_000) {
    return vi.fn(async () => ({
      spentMicros,
      evidence: rows.map((row, index) => ({
        id: `e-${index}`,
        kind: "keyword_metrics",
        observedAt: new Date(),
        dimensions: { query: row.query },
        metrics:
          row.volume == null
            ? {}
            : { "provider:volume": { value: row.volume, unit: "searches/month", source: "provider" } },
      })),
    }));
  }

  const applyInput = {
    projectId: "p1",
    siteId: "s1",
    monthStart: MONTH_START,
    languageCode: "en",
    locationCode: 2840,
    apply: true,
  };

  it("records the measured volume", async () => {
    const db = mockDb({ memberships: [grid("q1")] });
    const { result } = await measureGridVolume(db as never, {
      ...applyInput,
      collect: collectReturning([{ query: "q1", volume: 480 }]) as never,
    });
    expect(result.measured).toEqual([{ query: "q1", volume: 480 }]);
    expect(result.unmeasured).toEqual([]);
  });

  it("reports a query the provider had nothing for as unmeasured, never as zero", async () => {
    const db = mockDb({ memberships: [grid("q1"), grid("q2")] });
    const { result } = await measureGridVolume(db as never, {
      ...applyInput,
      collect: collectReturning([{ query: "q1", volume: 480 }, { query: "q2" }]) as never,
    });
    expect(result.measured).toEqual([{ query: "q1", volume: 480 }]);
    expect(result.unmeasured).toEqual(["q2"]);
  });

  it("does not call a zero volume a measurement", async () => {
    const db = mockDb({ memberships: [grid("q1")] });
    const { result } = await measureGridVolume(db as never, {
      ...applyInput,
      collect: collectReturning([{ query: "q1", volume: 0 }]) as never,
    });
    expect(result.measured).toEqual([]);
    expect(result.unmeasured).toEqual(["q1"]);
  });

  it("reports a cap hit as a truncation with the queries not sent", async () => {
    const queries = Array.from({ length: KEYWORD_BATCH_SIZE + 2 }, (_, index) => `query ${index}`);
    const db = mockDb({ memberships: queries.map((query) => grid(query)) });
    // Enough for one batch only: the second batch is never sent.
    const { result } = await measureGridVolume(db as never, {
      ...applyInput,
      capMicros: 1,
      collect: collectReturning(queries.map((query) => ({ query, volume: 10 }))) as never,
    });
    expect(result.batches).toBe(0);
    expect(result.truncations.count).toBe(queries.length);
    // A query that was never sent is not "unmeasured": that would hide the cap.
    expect(result.unmeasured).toEqual([]);
    expect(result.error).toContain("cap");
  });

  it("reports a provider failure instead of claiming a measurement", async () => {
    const db = mockDb({ memberships: [grid("q1")] });
    const { result } = await measureGridVolume(db as never, {
      ...applyInput,
      collect: vi.fn(async () => {
        throw new Error("provider unavailable");
      }) as never,
    });
    expect(result.measured).toEqual([]);
    expect(result.error).toContain("provider unavailable");
  });

  it("reports the batches it never sent when the provider refuses mid-run", async () => {
    // Measured 2026-11-24: the research budget ran out after the first batch and 61
    // queries were silently dropped. A partial measurement must say so.
    const queries = Array.from({ length: KEYWORD_BATCH_SIZE * 3 }, (_, index) => `query ${index}`);
    const db = mockDb({ memberships: queries.map((query) => grid(query)) });
    let call = 0;
    const { result } = await measureGridVolume(db as never, {
      ...applyInput,
      collect: vi.fn(async () => {
        call += 1;
        if (call > 1) throw new Error("Monetary research allowance is exhausted for this period");
        return {
          spentMicros: 2_000,
          evidence: queries.slice(0, KEYWORD_BATCH_SIZE).map((query) => ({
            id: query,
            kind: "keyword_metrics",
            observedAt: new Date(),
            dimensions: { query },
            metrics: { "provider:volume": { value: 40, unit: "searches/month", source: "provider" } },
          })),
        };
      }) as never,
    });
    expect(result.measured).toHaveLength(KEYWORD_BATCH_SIZE);
    expect(result.truncations.count).toBe(KEYWORD_BATCH_SIZE * 2);
    expect(result.error).toContain("allowance");
    // A query never sent must not be reported as "the provider had no volume".
    expect(result.unmeasured).toEqual([]);
  });
});
