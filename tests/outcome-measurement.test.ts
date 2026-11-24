import { describe, expect, it, vi } from "vitest";

import {
  OUTCOME_MIN_DAYS,
  OUTCOME_MIN_MOVE,
  confirmOutcomeWin,
  measureOutcome,
  readBaseline,
  storeOutcome,
  sweepDeliveredOutcomes,
} from "@/lib/funnel/outcome-measurement";

/**
 * CMP-009: the loop that was open.
 *
 * `OutcomeObservation` held **0 rows against 17 tasks**: every delivery and outcome path
 * existed in the schema and nothing wrote through it. These tests pin the two halves and
 * the four rules that keep the verdict honest:
 *
 *  - the baseline is read from the latest sample at acceptance,
 *  - `improved`/`unchanged`/`declined` are arithmetic at the named thresholds,
 *  - a task with no sample after delivery is `unmeasurable`, never `unchanged`,
 *  - the system's own verdict is never `verified_win`; a person records that.
 */

const NOW = new Date("2026-12-30T00:00:00Z");
const DELIVERED = new Date("2026-11-01T00:00:00Z");

const rank = (
  query: string,
  position: number,
  observedAt = new Date("2026-11-01T00:00:00Z"),
  impressions = 100
) => ({
  dimensions: { query, url: `https://oursite.com/${query.replace(/\s+/g, "-")}` },
  metrics: {
    "first_party:position": { value: position, unit: "rank", source: "first_party" },
    "first_party:impressions": { value: impressions, unit: "count", source: "first_party" },
  },
  observedAt,
});

const competitor = (query: string, domain: string, position: number, observedAt = new Date("2026-11-01T00:00:00Z")) => ({
  dimensions: { query, domain },
  metrics: { "provider:position": { value: position, unit: "rank", source: "provider" } },
  observedAt,
});

function mockDb(input: {
  ranks?: ReturnType<typeof rank>[];
  competitors?: ReturnType<typeof competitor>[];
  baseline?: Record<string, unknown> | null;
  taskUpdatedAt?: Date;
}) {
  const created: Array<Record<string, unknown>> = [];
  const stored: Array<Record<string, unknown>> = [];
  return {
    created,
    stored,
    db: {
      evidenceRecord: {
        findMany: vi.fn(async (args: { where: { kind: string; observedAt?: { gte?: Date; gt?: Date } } }) => {
          const rows = args.where.kind === "keyword_rank" ? (input.ranks ?? []) : (input.competitors ?? []);
          const floor = args.where.observedAt;
          if (floor?.gt) return rows.filter((row) => row.observedAt > floor.gt!);
          if (floor?.gte) return rows.filter((row) => row.observedAt >= floor.gte!);
          return rows;
        }),
      },
      task: {
        findUnique: vi.fn(async () => ({
          id: "t1",
          updatedAt: input.taskUpdatedAt ?? DELIVERED,
          opportunity: { dedupKey: "O2:condos for sale:https://oursite.com/x", projectId: "p1" },
          baselines: input.baseline
            ? [{ metrics: input.baseline, observedAt: new Date("2026-11-01T00:00:00Z") }]
            : [],
        })),
        findMany: vi.fn(async () => [
          {
            id: "t1",
            updatedAt: input.taskUpdatedAt ?? DELIVERED,
            outcomeObservations: stored.length ? [{ id: "o1" }] : [],
          },
        ]),
      },
      opportunity: { findUnique: vi.fn() },
      baseline: { create: vi.fn(async (args: { data: Record<string, unknown> }) => { created.push(args.data); return { id: "b1" }; }) },
      outcomeObservation: {
        findFirst: vi.fn(async () => (stored.length ? { id: "existing", verdict: "no_effect", afterMetrics: {} } : null)),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          stored.push(args.data);
          return { id: `o-${stored.length}` };
        }),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "o1", ...args.data })),
      },
    },
  };
}

const measuredBaseline = {
  unobserved: false,
  reason: null,
  query: "condos for sale",
  position: 12,
  competitorDomain: "rival.com",
  competitorPosition: 4,
  url: "https://oursite.com/condos",
};

describe("CMP-009 the baseline is read at acceptance", () => {
  it("captures our position and the competitor URL ahead of us", async () => {
    const { db } = mockDb({
      ranks: [rank("condos for sale", 12)],
      competitors: [competitor("condos for sale", "rival.com", 4), competitor("condos for sale", "below.com", 20)],
    });
    const baseline = await readBaseline(db as never, {
      projectId: "p1",
      dedupKey: "O2:condos for sale:https://oursite.com/x",
      siteDomain: "oursite.com",
    });
    expect(baseline.unobserved).toBe(false);
    expect(baseline.position).toBe(12);
    expect(baseline.competitorDomain).toBe("rival.com");
    expect(baseline.competitorPosition).toBe(4);
    expect(baseline.query).toBe("condos for sale");
  });

  it("does not name a competitor that ranks below us as the page to beat", async () => {
    const { db } = mockDb({
      ranks: [rank("condos for sale", 3)],
      competitors: [competitor("condos for sale", "below.com", 9)],
    });
    const baseline = await readBaseline(db as never, {
      projectId: "p1",
      dedupKey: "O2:condos for sale:https://oursite.com/x",
      siteDomain: "oursite.com",
    });
    expect(baseline.position).toBe(3);
    // Nobody was ahead of us, so there is no page to pass.
    expect(baseline.competitorDomain).toBeNull();
  });

  it("records unobserved with a reason when no sample names the query", async () => {
    const { db } = mockDb({ ranks: [], competitors: [] });
    const baseline = await readBaseline(db as never, {
      projectId: "p1",
      dedupKey: "O2:unmeasured query:https://oursite.com/x",
      siteDomain: "oursite.com",
    });
    expect(baseline.unobserved).toBe(true);
    expect(baseline.position).toBeNull();
    expect(baseline.reason).toBeTruthy();
  });

  it("records unobserved when the opportunity names no query", async () => {
    const { db } = mockDb({});
    const baseline = await readBaseline(db as never, {
      projectId: "p1",
      dedupKey: "phase3:content_business:abc123",
      siteDomain: "oursite.com",
    });
    expect(baseline.unobserved).toBe(true);
    expect(baseline.reason).toContain("does not name a query");
  });

  it("takes the newest measurement, not the best position ever recorded", async () => {
    // Measured 2026-11-24 on atelier-harmonie's `renover abat jour`: the history holds a
    // 6 three weeks before the opportunity existed and a 9.125 on the newest date. A
    // baseline built from the page's best day would make the delivery look like a
    // three-place fall it did not cause.
    const { db } = mockDb({
      ranks: [
        rank("condos for sale", 6, new Date("2026-10-30T00:00:00Z")),
        rank("condos for sale", 9.13, new Date("2026-11-22T00:00:00Z")),
      ],
    });
    const baseline = await readBaseline(db as never, {
      projectId: "p1",
      dedupKey: "O1:condos for sale:https://oursite.com/x",
      siteDomain: "oursite.com",
    });
    expect(baseline.position).toBe(9.13);
    expect(baseline.observedAt?.toISOString().slice(0, 10)).toBe("2026-11-22");
  });

  it("weights several rows on one day by impressions, because a day is not a position", async () => {
    // Two rows for one date: one position on 1 impression, one on 900. The 900 must
    // dominate — an unweighted mean would let the single-impression row move the number.
    const { db } = mockDb({
      ranks: [
        rank("condos for sale", 20, new Date("2026-11-01T00:00:00Z"), 1),
        rank("condos for sale", 6, new Date("2026-11-01T00:00:00Z"), 900),
      ],
    });
    const baseline = await readBaseline(db as never, {
      projectId: "p1",
      dedupKey: "O1:condos for sale:https://oursite.com/x",
      siteDomain: "oursite.com",
    });
    expect(baseline.position).toBeCloseTo((20 * 1 + 6 * 900) / 901, 2);
  });

  it("keeps a sampled SERP with no impression count rather than discarding it", async () => {
    // A provider sample has no impressions. It must still count — at weight 1 — or a
    // site with no Search Console history could never be measured at all.
    const { db } = mockDb({
      ranks: [
        {
          dimensions: { query: "condos for sale", url: "https://oursite.com/x" },
          metrics: { "provider:position": { value: 7, unit: "rank", source: "provider" } },
          observedAt: new Date("2026-11-05T00:00:00Z"),
        },
      ] as never,
    });
    const baseline = await readBaseline(db as never, {
      projectId: "p1",
      dedupKey: "O1:condos for sale:https://oursite.com/x",
      siteDomain: "oursite.com",
    });
    expect(baseline.position).toBe(7);
    expect(baseline.unobserved).toBe(false);
  });
});

describe("CMP-009 verdicts are arithmetic at the named thresholds", () => {
  const measure = async (afterPosition: number, over: { competitors?: ReturnType<typeof competitor>[] } = {}) => {
    const { db } = mockDb({
      baseline: measuredBaseline,
      ranks: [rank("condos for sale", afterPosition, new Date("2026-12-15T00:00:00Z"))],
      competitors: over.competitors ?? [competitor("condos for sale", "rival.com", 3, new Date("2026-12-15T00:00:00Z"))],
    });
    return measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
  };

  it("is improved at exactly the minimum move, and not one place less", async () => {
    // Baseline 12; a gain is baseline − after, so 12 − 9 = 3 places is the threshold.
    expect((await measure(12 - OUTCOME_MIN_MOVE)).verdict).toBe("improved");
    expect((await measure(12 - OUTCOME_MIN_MOVE + 1)).verdict).toBe("unchanged");
  });

  it("is declined at exactly the minimum move the other way", async () => {
    expect((await measure(12 + OUTCOME_MIN_MOVE)).verdict).toBe("declined");
    expect((await measure(12 + OUTCOME_MIN_MOVE - 1)).verdict).toBe("unchanged");
  });

  it("is unchanged inside the band, in both directions", async () => {
    expect((await measure(11)).verdict).toBe("unchanged");
    expect((await measure(13)).verdict).toBe("unchanged");
  });

  it("reports the signed places moved", async () => {
    const improved = await measure(5);
    expect(improved.positionDelta).toBe(7);
    const declined = await measure(18);
    expect(declined.positionDelta).toBe(-6);
  });

  it("states the limitation on every measurement", async () => {
    const result = await measure(5);
    expect(result.limitation).toContain("not proof this work caused it");
    expect(result.limitation).toContain("seasonality");
  });
});

describe("CMP-009 the competitor comparison is filled, or left null", () => {
  it("records that we passed the competitor we were chasing", async () => {
    const { db } = mockDb({
      baseline: measuredBaseline,
      ranks: [rank("condos for sale", 2, new Date("2026-12-15T00:00:00Z"))],
      competitors: [competitor("condos for sale", "rival.com", 5, new Date("2026-12-15T00:00:00Z"))],
    });
    const result = await measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
    expect(result.passedCompetitor).toBe(true);
    expect(result.competitorAfterPosition).toBe(5);
    // They went 4 -> 5, one place worse.
    expect(result.competitorDelta).toBe(-1);
  });

  it("leaves the competitor null, not zero, when no sample named it", async () => {
    const { db } = mockDb({
      baseline: measuredBaseline,
      ranks: [rank("condos for sale", 2, new Date("2026-12-15T00:00:00Z"))],
      competitors: [],
    });
    const result = await measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
    expect(result.competitorAfterPosition).toBeNull();
    expect(result.passedCompetitor).toBeNull();
    // Our own change is still measured.
    expect(result.verdict).toBe("improved");
  });
});

describe("CMP-009 unmeasurable is not unchanged", () => {
  it("waits inside the 28-day window instead of claiming a result", async () => {
    const { db } = mockDb({ baseline: measuredBaseline, ranks: [rank("condos for sale", 2)] });
    const result = await measureOutcome(db as never, {
      taskId: "t1",
      projectId: "p1",
      deliveredAt: DELIVERED,
      now: new Date(DELIVERED.getTime() + (OUTCOME_MIN_DAYS - 1) * 86_400_000),
    });
    expect(result.verdict).toBe("unmeasurable");
    expect(result.reason).toContain(`${OUTCOME_MIN_DAYS} days`);
    expect(result.afterPosition).toBeNull();
  });

  it("is unmeasurable when the query has no sample after delivery", async () => {
    const { db } = mockDb({ baseline: measuredBaseline, ranks: [] });
    const result = await measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
    expect(result.verdict).toBe("unmeasurable");
    expect(result.reason).toContain("No sample");
    expect(result.positionDelta).toBeNull();
  });

  it("is unmeasurable when no sample is newer than the baseline", async () => {
    // Measured 2026-11-24 on a real accepted task: the baseline came from the newest stored
    // sample, the after-read then read that same row back, and the result was "unchanged".
    // A verdict manufactured from zero new data is worse than no verdict, because it looks
    // like a measurement. The window had closed; nothing had been sampled since.
    const { db } = mockDb({
      baseline: measuredBaseline,
      // One sample, and it is the one the baseline was taken from. Delivered long ago, so
      // the 28-day window has closed *around* that sample — which is exactly the shape
      // that produced the false "unchanged".
      ranks: [rank("condos for sale", 12, new Date("2026-11-01T00:00:00Z"))],
    });
    const result = await measureOutcome(db as never, {
      taskId: "t1",
      projectId: "p1",
      deliveredAt: new Date("2026-10-01T00:00:00Z"),
      now: NOW,
    });
    expect(result.verdict).toBe("unmeasurable");
    expect(result.afterPosition).toBeNull();
    expect(result.positionDelta).toBeNull();
    expect(result.reason).toContain("after the baseline");
  });

  it("does measure once a genuinely newer sample exists", async () => {
    // The complement: the same task, with one sample after the baseline, is measured.
    const { db } = mockDb({
      baseline: measuredBaseline,
      ranks: [
        rank("condos for sale", 12, new Date("2026-11-01T00:00:00Z")),
        rank("condos for sale", 4, new Date("2026-12-15T00:00:00Z")),
      ],
    });
    const result = await measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
    expect(result.verdict).toBe("improved");
    expect(result.afterPosition).toBe(4);
    expect(result.positionDelta).toBe(8);
  });

  it("is unmeasurable when no baseline was captured", async () => {
    const { db } = mockDb({ baseline: null, ranks: [rank("condos for sale", 2)] });
    const result = await measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
    expect(result.verdict).toBe("unmeasurable");
    expect(result.reason).toContain("No baseline");
  });

  it("writes no OutcomeObservation row for unmeasurable work", async () => {
    const { db, stored } = mockDb({ baseline: measuredBaseline, ranks: [] });
    const result = await measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
    const write = await storeOutcome(db as never, { measurement: result, deliveredAt: DELIVERED });
    expect(write.created).toBe(false);
    expect(stored).toEqual([]);
  });
});

describe("CMP-009 one observation per task per window", () => {
  it("stores a measured outcome with both sides", async () => {
    const { db, stored } = mockDb({
      baseline: measuredBaseline,
      ranks: [rank("condos for sale", 4, new Date("2026-12-15T00:00:00Z"))],
      competitors: [competitor("condos for sale", "rival.com", 6, new Date("2026-12-15T00:00:00Z"))],
    });
    const measurement = await measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
    const write = await storeOutcome(db as never, { measurement, deliveredAt: DELIVERED });
    expect(write.created).toBe(true);
    expect(stored).toHaveLength(1);
    const row = stored[0];
    expect(row.measuredBy).toBe("site-cycle");
    const after = row.afterMetrics as Record<string, unknown>;
    expect(after.verdict).toBe("improved");
    expect(after.position).toBe(4);
    expect(after.limitation).toContain("not proof");
    // The schema enum cannot express four verdicts; the real one travels in metrics.
    expect(row.verdict).not.toBe("verified_win");
  });

  it("does not duplicate an observation for the same window", async () => {
    const { db, stored } = mockDb({
      baseline: measuredBaseline,
      ranks: [rank("condos for sale", 4, new Date("2026-12-15T00:00:00Z"))],
    });
    (db.outcomeObservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "existing" });
    const measurement = await measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
    const write = await storeOutcome(db as never, { measurement, deliveredAt: DELIVERED });
    expect(write.created).toBe(false);
    expect(write.id).toBe("existing");
    expect(stored).toEqual([]);
  });

  it("sweeps waiting, unmeasurable and already-measured separately", async () => {
    const { db } = mockDb({ baseline: measuredBaseline, ranks: [], taskUpdatedAt: DELIVERED });
    const sweep = await sweepDeliveredOutcomes(db as never, { projectId: "p1", now: NOW });
    // The query has no sample after delivery, and the window has closed.
    expect(sweep.unmeasurable).toBe(1);
    expect(sweep.waiting).toBe(0);
    expect(sweep.measured).toBe(0);
    expect(sweep.unbaselined).toBe(0);
  });

  it("reports a task inside its window as waiting, not as unmeasurable", async () => {
    // Measured 2026-11-24: nine live delivered tasks were all inside or past their
    // window, so the two states must not be merged into one counter.
    const { db } = mockDb({ baseline: measuredBaseline, ranks: [rank("condos for sale", 4)], taskUpdatedAt: DELIVERED });
    const sweep = await sweepDeliveredOutcomes(db as never, {
      projectId: "p1",
      now: new Date(DELIVERED.getTime() + 5 * 86_400_000),
    });
    expect(sweep.waiting).toBe(1);
    expect(sweep.unmeasurable).toBe(0);
  });

  it("does not report a task with no baseline as waiting", async () => {
    // The ticket forbids backfilling a task that never had a baseline. Calling it
    // "waiting" promises a measurement that no amount of time will produce.
    const { db } = mockDb({ baseline: null, ranks: [rank("condos for sale", 4, new Date("2026-12-15T00:00:00Z"))] });
    const sweep = await sweepDeliveredOutcomes(db as never, { projectId: "p1", now: NOW });
    expect(sweep.unbaselined).toBe(1);
    expect(sweep.waiting).toBe(0);
    expect(sweep.unmeasurable).toBe(0);
    expect(sweep.measured).toBe(0);
    expect(sweep.tasks[0].verdict).toBe("unbaselined");
    expect(sweep.tasks[0].reason).toContain("No baseline");
    // And says that backfilling is not on the table, so nobody waits for it.
    expect(sweep.tasks[0].reason).toContain("backfilling one is not allowed");
  });

  it("reports a task whose opportunity names no query as unbaselined", async () => {
    const { db } = mockDb({ baseline: null, ranks: [] });
    (db.task.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t1",
      updatedAt: DELIVERED,
      opportunity: { dedupKey: "phase3:content_business:52ac11fcf047c488", projectId: "p1" },
      baselines: [],
    });
    const sweep = await sweepDeliveredOutcomes(db as never, { projectId: "p1", now: NOW });
    expect(sweep.unbaselined).toBe(1);
    // Not "waiting": a lane slug is not a query, so there is nothing to wait for.
    expect(sweep.tasks[0].reason).toContain("does not name a query");
  });
});

describe("CMP-009 only a person records a win", () => {
  it("never writes verified_win from its own measurement", async () => {
    const { db, stored } = mockDb({
      baseline: measuredBaseline,
      ranks: [rank("condos for sale", 1, new Date("2026-12-15T00:00:00Z"))],
      competitors: [competitor("condos for sale", "rival.com", 2, new Date("2026-12-15T00:00:00Z"))],
    });
    const measurement = await measureOutcome(db as never, { taskId: "t1", projectId: "p1", deliveredAt: DELIVERED, now: NOW });
    await storeOutcome(db as never, { measurement, deliveredAt: DELIVERED });
    // Even a dramatic improvement with the competitor passed is not a win the system
    // can declare.
    expect(measurement.passedCompetitor).toBe(true);
    expect(stored[0].verdict).not.toBe("verified_win");
  });

  it("records verified_win only through the human confirmation", async () => {
    const { db } = mockDb({ baseline: measuredBaseline, ranks: [rank("condos for sale", 1)] });
    (db.outcomeObservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "o1",
      verdict: "no_effect",
      afterMetrics: { position: 3 },
    });
    const result = await confirmOutcomeWin(db as never, { taskId: "t1", confirmedBy: "dana" });
    expect(result.id).toBe("o1");
    const update = (db.outcomeObservation.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      data: { verdict: string; afterMetrics: Record<string, unknown> };
    };
    expect(update.data.verdict).toBe("verified_win");
    expect(update.data.afterMetrics.confirmedBy).toBe("dana");
  });

  it("refuses to confirm a win on a task with no measured outcome", async () => {
    const { db } = mockDb({ baseline: null });
    (db.outcomeObservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(confirmOutcomeWin(db as never, { taskId: "t1", confirmedBy: "dana" })).rejects.toThrow(
      /no measured outcome/
    );
  });

  it("requires a name on the confirmation", async () => {
    const { db } = mockDb({ baseline: measuredBaseline });
    await expect(confirmOutcomeWin(db as never, { taskId: "t1", confirmedBy: "  " })).rejects.toThrow(/person who verified/);
  });
});

describe("CMP-009 the baseline describes acceptance, not today", () => {
  it("bounds the read to the acceptance moment", async () => {
    // Without the bound, re-running a baseline would return the newest sample and the
    // "before" in a before/after report would drift every time someone looked.
    const seen: Array<{ lte?: Date } | undefined> = [];
    const db = {
      evidenceRecord: {
        findMany: vi.fn(async (args: { where: { kind: string; observedAt?: { lte?: Date } } }) => {
          seen.push(args.where.observedAt);
          const rows =
            args.where.kind === "keyword_rank"
              ? [
                  rank("condos for sale", 12, new Date("2026-10-20T00:00:00Z")),
                  rank("condos for sale", 3, new Date("2026-12-20T00:00:00Z")),
                ]
              : [];
          const cutoff = args.where.observedAt?.lte;
          return cutoff ? rows.filter((row) => row.observedAt <= cutoff) : rows;
        }),
      },
    };
    const baseline = await readBaseline(db as never, {
      projectId: "p1",
      dedupKey: "O1:condos for sale:https://oursite.com/x",
      siteDomain: "oursite.com",
      at: new Date("2026-11-01T00:00:00Z"),
    });
    // The December sample is after acceptance, so it must not be the baseline.
    expect(baseline.position).toBe(12);
    expect(baseline.observedAt?.toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(seen.every((filter) => filter?.lte instanceof Date)).toBe(true);
  });

  it("reports an acceptance before any sample as unobserved, not as a stale number", async () => {
    const db = {
      evidenceRecord: {
        // Honours the bound, as the real query does: the only sample is after acceptance.
        findMany: vi.fn(async (args: { where: { observedAt?: { lte?: Date } } }) => {
          const cutoff = args.where.observedAt?.lte;
          const rows = [rank("condos for sale", 5, new Date("2026-12-01T00:00:00Z"))];
          return cutoff ? rows.filter((row) => row.observedAt <= cutoff) : rows;
        }),
      },
    };
    const baseline = await readBaseline(db as never, {
      projectId: "p1",
      dedupKey: "O1:condos for sale:https://oursite.com/x",
      siteDomain: "oursite.com",
      at: new Date("2026-11-01T00:00:00Z"),
    });
    expect(baseline.unobserved).toBe(true);
    expect(baseline.position).toBeNull();
  });
});
