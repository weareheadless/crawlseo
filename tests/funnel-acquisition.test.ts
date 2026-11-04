import { describe, expect, it, vi } from "vitest";

import { planAcquisition, runAcquisitionPlan, MIN_OBSERVED_IMPRESSIONS } from "@/lib/funnel/acquisition";
import { performanceWindowEndingAt } from "@/lib/funnel/performance-window";

/**
 * Paid collection followed research hypotheses only, so on a connected site the
 * measured phrases and the ranking phrases were disjoint: seven measured keywords,
 * zero matching a ranking query, and no effect on the board.
 */
const observed = (query: string, impressions: number, clicks = 0) => ({
  query,
  url: "https://site.test/page",
  impressions,
  clicks,
  position: 9,
});

describe("acquisition plan", () => {
  it("measures observed performance before hypotheses", () => {
    const plan = planAcquisition({
      observed: [observed("puerto morelos condos for sale", 58)],
      hypotheses: [{ query: "custom lampshades", opportunityId: "o1" }],
    });
    expect(plan.requests.map((row) => row.reason)).toEqual(["observed_performance", "research_hypothesis"]);
    expect(plan.requests[0].priority).toBeGreaterThan(plan.requests[1].priority);
  });

  it("orders observed queries by impressions", () => {
    const plan = planAcquisition({
      observed: [observed("small", 12), observed("big", 269), observed("mid", 58)],
    });
    expect(plan.requests.map((row) => row.query)).toEqual(["big", "mid", "small"]);
  });

  it("does not pay twice for a fresh measurement", () => {
    const plan = planAcquisition({
      observed: [observed("already measured", 200)],
      measuredQueries: ["Already  Measured"],
    });
    expect(plan.requests).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain("already measured");
  });

  it("skips a query with too few impressions to justify a call", () => {
    const plan = planAcquisition({ observed: [observed("thin", MIN_OBSERVED_IMPRESSIONS - 1)] });
    expect(plan.requests).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain("impressions");
  });

  it("merges hypotheses that name the same query and keeps their opportunities", () => {
    const plan = planAcquisition({
      observed: [],
      hypotheses: [
        { query: "Sargassum risk", opportunityId: "o1" },
        { query: "sargassum risk", opportunityId: "o2" },
      ],
    });
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0].opportunityIds).toEqual(["o1", "o2"]);
  });

  it("never lets a hypothesis displace an observed query for the same query", () => {
    const plan = planAcquisition({
      observed: [observed("tulum real estate", 79)],
      hypotheses: [{ query: "Tulum Real Estate", opportunityId: "o1" }],
    });
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0].reason).toBe("observed_performance");
  });

  it("records what the limit left out instead of silently dropping it", () => {
    const plan = planAcquisition({ observed: [observed("a", 300), observed("b", 200)], limit: 1 });
    expect(plan.requests).toHaveLength(1);
    expect(plan.skipped.some((row) => row.reason.includes("limit"))).toBe(true);
  });
});

describe("acquisition execution", () => {
  const window = performanceWindowEndingAt(new Date("2026-10-31T00:00:00.000Z"), 28);

  const db = (measured: string[] = []) => ({
    evidenceRecord: {
      findMany: vi.fn(async () => measured.map((query) => ({ dimensions: { query }, observedAt: new Date("2026-10-30T00:00:00.000Z") }))),
    },
    keyword: { findFirst: vi.fn() },
    page: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  });

  it("batches calls and counts what was measured", async () => {
    const collect = vi.fn(async ({ queries }: { queries: string[] }) => ({
      evidence: queries.map((query) => ({ id: `e-${query}`, dimensions: { query } })),
      spentMicros: 1_000,
    }));
    const receipt = await runAcquisitionPlan(db() as never, {
      projectId: "p1",
      siteId: "s1",
      window,
      performance: Array.from({ length: 25 }, (_, index) => ({
        query: `q${index}`, url: "u", impressions: 100 - index, clicks: 0, ctr: 0,
        position: 9, observations: 1, segments: 1, firstDate: window.start, lastDate: window.end,
      })),
      collect,
      maxSpendMicros: 1_000_000,
    });
    expect(collect).toHaveBeenCalledTimes(2);
    expect(receipt.measured).toBe(25);
    expect(receipt.spentMicros).toBe(2_000);
    expect(receipt.window?.days).toBe(28);
  });

  it("stops at the spend ceiling and says so", async () => {
    const collect = vi.fn(async ({ queries }: { queries: string[] }) => ({
      evidence: queries.map((query) => ({ id: `e-${query}`, dimensions: { query } })),
      spentMicros: 500_000,
    }));
    const receipt = await runAcquisitionPlan(db() as never, {
      projectId: "p1",
      siteId: "s1",
      window,
      performance: Array.from({ length: 40 }, (_, index) => ({
        query: `q${index}`, url: "u", impressions: 100, clicks: 0, ctr: 0,
        position: 9, observations: 1, segments: 1, firstDate: window.start, lastDate: window.end,
      })),
      collect,
      maxSpendMicros: 500_000,
    });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(receipt.skipped.some((row) => row.reason.includes("ceiling"))).toBe(true);
  });

  it("distinguishes no data from a failure", async () => {
    const collect = vi.fn(async () => ({ evidence: [], spentMicros: 500 }));
    const receipt = await runAcquisitionPlan(db() as never, {
      projectId: "p1",
      siteId: "s1",
      window,
      performance: [{
        query: "q", url: "u", impressions: 100, clicks: 0, ctr: 0,
        position: 9, observations: 1, segments: 1, firstDate: window.start, lastDate: window.end,
      }],
      collect,
      maxSpendMicros: 100_000,
    });
    expect(receipt.noData).toBe(1);
    expect(receipt.failed).toBe(0);
    expect(receipt.requests[0].state).toBe("no_data");
  });

  it("records a provider failure per batch without aborting the plan", async () => {
    const collect = vi.fn(async () => {
      throw new Error("A USD research allowance is required before paid collection");
    });
    const receipt = await runAcquisitionPlan(db() as never, {
      projectId: "p1",
      siteId: "s1",
      window,
      performance: [{
        query: "q", url: "u", impressions: 100, clicks: 0, ctr: 0,
        position: 9, observations: 1, segments: 1, firstDate: window.start, lastDate: window.end,
      }],
      collect,
      maxSpendMicros: 100_000,
    });
    expect(receipt.failed).toBe(1);
    expect(receipt.noData).toBe(0);
    expect(receipt.skipped[0].reason).toContain("allowance");
  });
});
