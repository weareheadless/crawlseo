import { describe, expect, it, vi } from "vitest";

import { compareRankWindows, MIN_COMPARISON_GAP_DAYS } from "@/lib/funnel/evidence";

/**
 * CMP-010: a decline means the query actually declined.
 *
 * The defect was not a threshold, it was the **pair**. A daily sync re-projects a rolling
 * 28-day window every day, so selecting "the second-newest `windowEnd`" compared yesterday's
 * current window with today's — **27 of 28 days identical**. Measured on Susi: 51% of pairs
 * differed by exactly 0, median |Δ| 0.00, and O11 fired **once** instead of ~43 times.
 *
 * These tests pin the selection rules, because every one of them failed silently before:
 *  - the previous window is the one with `windowRole: "previous"`, from the latest projection
 *    that has both roles,
 *  - a row with no role is excluded and **counted**, never used as a comparison,
 *  - two windows that overlap are refused, with the overlap stated,
 *  - and a project with one window says why it cannot compare rather than showing nothing.
 */

const DAY = 86_400_000;
const iso = (date: string) => `${date}T00:00:00.000Z`;

type Row = {
  id: string;
  kind: string;
  observedAt: Date;
  dimensions: Record<string, unknown>;
  metrics: Record<string, { value: number; unit: string; source: string }>;
};

function rank(input: {
  id: string;
  query?: string;
  url?: string;
  windowEnd: string;
  windowRole?: "current" | "previous";
  windowDays?: number;
  position?: number;
  impressions?: number;
}): Row {
  const dimensions: Record<string, unknown> = {
    query: input.query ?? "condos for sale",
    url: input.url ?? "https://x.com/a",
    windowEnd: iso(input.windowEnd),
  };
  if (input.windowRole) dimensions.windowRole = input.windowRole;
  if (input.windowDays != null) dimensions.windowDays = input.windowDays;
  return {
    id: input.id,
    kind: "keyword_rank",
    observedAt: new Date(iso(input.windowEnd)),
    dimensions,
    metrics: {
      "first_party:position": { value: input.position ?? 6, unit: "rank", source: "first_party" },
      "first_party:impressions": { value: input.impressions ?? 100, unit: "count", source: "first_party" },
    },
  };
}

describe("CMP-010 the pair is selected by declared role, not by array position", () => {
  it("compares the current window against the previous-role window 28 days earlier", () => {
    // The live shape: many `current` rows written daily, and one `previous` row from the same
    // projection. The newest `current` is 2026-11-20; the previous window ends 2026-10-23.
    const rows = [
      rank({ id: "c19", windowEnd: "2026-11-19", windowRole: "current" }),
      rank({ id: "c20", windowEnd: "2026-11-20", windowRole: "current" }),
      rank({ id: "p", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28 }),
    ].map((row) => ({ ...row, dimensions: { ...row.dimensions, windowDays: 28 } }));
    const comparison = compareRankWindows(rows as never);
    expect(comparison.current.map((row) => row.id)).toEqual(["c20"]);
    expect(comparison.previous.map((row) => row.id)).toEqual(["p"]);
    expect(comparison.currentWindowEnd).toBe(iso("2026-11-20"));
    expect(comparison.previousWindowEnd).toBe(iso("2026-10-23"));
    // 28 days apart for a 28-day window: no shared data.
    expect(comparison.overlapDays).toBe(0);
    expect(comparison.gapDays).toBe(28);
    expect(comparison.reason).toBeNull();
  });

  it("does not treat yesterday's current window as the previous window", () => {
    // This is the exact bug: without roles, the second-newest `windowEnd` is 2026-11-19, which
    // overlaps the current window by 27 of 28 days.
    const rows = [
      rank({ id: "c19", windowEnd: "2026-11-19", windowRole: "current", windowDays: 28 }),
      rank({ id: "c20", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28 }),
      rank({ id: "p", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28 }),
    ];
    const comparison = compareRankWindows(rows as never);
    expect(comparison.previous.map((row) => row.id)).not.toContain("c19");
    expect(comparison.overlapDays).toBe(0);
  });

  it("takes the previous window from the latest projection that has one", () => {
    const rows = [
      rank({ id: "oldP", windowEnd: "2026-09-25", windowRole: "previous", windowDays: 28 }),
      rank({ id: "newP", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28 }),
      rank({ id: "c", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28 }),
    ];
    const comparison = compareRankWindows(rows as never);
    expect(comparison.previousWindowEnd).toBe(iso("2026-10-23"));
  });
});

describe("CMP-010 overlapping windows are refused with the reason", () => {
  it("refuses a previous window that starts inside the current one", () => {
    // Ending 2026-11-12 against a 28-day window ending 2026-11-20: they share 21 days, which
    // is under the gap floor.
    const rows = [
      rank({ id: "c", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28 }),
      rank({ id: "p", windowEnd: "2026-11-12", windowRole: "previous", windowDays: 28 }),
    ];
    const comparison = compareRankWindows(rows as never);
    expect(comparison.previous).toEqual([]);
    expect(comparison.reason).toBeTruthy();
    expect(comparison.reason).toContain("overlap");
    // The overlap is stated so a person can see why.
    expect(comparison.overlapDays).toBeGreaterThan(28 - MIN_COMPARISON_GAP_DAYS);
  });

  it("states the overlap it used for an accepted pair", () => {
    const rows = [
      rank({ id: "c", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28 }),
      rank({ id: "p", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28 }),
    ];
    const comparison = compareRankWindows(rows as never);
    expect(comparison.overlapDays).toBe(0);
    expect(comparison.gapDays).toBe(28);
  });
});

describe("CMP-010 a row with no role is excluded and counted", () => {
  it("counts legacy rows and never compares them", () => {
    const rows = [
      rank({ id: "legacy", windowEnd: "2026-11-20", position: 3 }),
      rank({ id: "c", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28 }),
      rank({ id: "p", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28 }),
    ];
    // The legacy row has no `windowRole` at all, so it is not a comparison on either side.
    const legacyRow = rows[0];
    const comparison = compareRankWindows(rows as never);
    expect(comparison.previous.map((row) => row.id)).toEqual(["p"]);
    expect(comparison.current.map((row) => row.id)).toEqual(["c"]);
    void legacyRow;
  });

  it("counts rows whose role is missing, so the exclusion is visible", () => {
    const rows = [
      rank({ id: "legacy1", windowEnd: "2026-11-20" }),
      rank({ id: "legacy2", windowEnd: "2026-11-19" }),
      rank({ id: "c", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28 }),
      rank({ id: "p", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28 }),
    ];
    const comparison = compareRankWindows(rows as never);
    // Measured on Susi: 281 such rows. They are not deleted, and they are not compared.
    expect(comparison.legacyRows).toBe(2);
  });
});

describe("CMP-010 one projected window says why, rather than showing nothing", () => {
  it("reports no comparison when only a current window exists, but keeps it selectable", () => {
    const rows = [rank({ id: "c", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28 })];
    const comparison = compareRankWindows(rows as never);
    expect(comparison.current.map((row) => row.id)).toEqual(["c"]);
    expect(comparison.previous).toEqual([]);
    expect(comparison.reason).toContain("Only one rank window");
  });

  it("reports no comparison when only a previous window exists", () => {
    const rows = [rank({ id: "p", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28 })];
    const comparison = compareRankWindows(rows as never);
    expect(comparison.previous).toEqual([]);
    expect(comparison.reason).toContain("No current rank window");
  });

  it("keeps every row when nothing declares a period at all", () => {
    // The documented legacy allowance: an un-migrated project still analyses.
    const rows = [rank({ id: "a", windowEnd: "2026-11-20" }), rank({ id: "b", windowEnd: "2026-11-19" })];
    for (const row of rows) delete row.dimensions.windowEnd;
    const comparison = compareRankWindows(rows as never);
    expect(comparison.current).toHaveLength(2);
    expect(comparison.previous).toEqual([]);
  });
});

/**
 * The selector is generic over any row with id/kind/observedAt/dimensions, so its return type
 * does not carry the fixture rows' `metrics`. This wrapper keeps them typed for the assertions
 * that read a position back out.
 */
function compare(rows: Row[]) {
  return compareRankWindows(rows as never) as unknown as {
    current: Row[];
    previous: Row[];
    currentWindowEnd: string | null;
    previousWindowEnd: string | null;
    overlapDays: number | null;
    gapDays: number | null;
    legacyRows: number;
    reason: string | null;
  };
}

describe("CMP-010 the honest pair produces the movement, the overlapping one does not", () => {
  /**
   * The measured outcome in miniature. One query, three rows:
   *  - a `previous` window 28 days back where the position was 6,
   *  - a `current` window where it is 14,
   *  - and yesterday's `current` window where it is also 14 — which is what the old selector
   *    compared against, producing a delta of 0.
   */
  const rows = [
    rank({ id: "prev", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28, position: 6 }),
    rank({ id: "cur", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28, position: 14 }),
    rank({ id: "yes", windowEnd: "2026-11-19", windowRole: "current", windowDays: 28, position: 14 }),
  ];

  it("finds the real decline against the honest pair", () => {
    const comparison = compare(rows);
    const before = comparison.previous[0];
    const after = comparison.current[0];
    const beforePos = before.metrics["first_party:position"].value;
    const afterPos = after.metrics["first_party:position"].value;
    expect(afterPos - beforePos).toBe(8);
  });

  it("yields no movement at all from the overlapping pair the old code chose", () => {
    // Yesterday vs today: identical position, so the old pairing could never report this
    // decline — and would report a change only when rounding noise produced one.
    expect(rows[2].metrics["first_party:position"].value - rows[1].metrics["first_party:position"].value).toBe(0);
  });

  it("does not produce a comparison for a query whose position did not move", () => {
    const flat = [
      rank({ id: "prev", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28, position: 9 }),
      rank({ id: "cur", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28, position: 9 }),
    ];
    const comparison = compare(flat);
    const before = comparison.previous[0].metrics["first_party:position"].value;
    const after = comparison.current[0].metrics["first_party:position"].value;
    expect(after - before).toBe(0);
  });
});

describe("CMP-010 O11 fires on a real decline and not on noise", () => {
  const rows = [
    rank({ id: "prev", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28, position: 6 }),
    rank({ id: "cur", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28, position: 14 }),
  ];

  it("carries both window dates in the dedup key, so two declines are two rows", async () => {
    // The later window is part of the identity: a decline measured in November is a
    // different observation from one measured in October, and merging them hides that the
    // site moved twice.
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const created: Array<Record<string, unknown>> = [];
    const byDedup = new Map<string, { id: string; status: string }>();
    let counter = 0;
    const db = {
      evidenceRecord: { findMany: vi.fn(async () => rows) },
      demandMapCluster: { findMany: vi.fn().mockResolvedValue([]) },
      site: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => null) },
      auditPage: { findMany: vi.fn(async () => []) },
      opportunity: {
        findMany: vi.fn(async () => [...byDedup.values()].map((row) => ({ id: row.id, status: row.status, scoreValue: 0 }))),
        findUnique: vi.fn(async (args: { where: { projectId_dedupKey: { dedupKey: string } } }) =>
          byDedup.get(args.where.projectId_dedupKey.dedupKey) ?? null
        ),
        create: vi.fn(async (args: { data: Record<string, unknown> & { dedupKey: string } }) => {
          counter += 1;
          const record = { id: `op-${counter}`, status: "detected", ...args.data };
          byDedup.set(args.data.dedupKey, { id: record.id, status: "detected" });
          created.push(record);
          return record;
        }),
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({ id: args.where.id, ...args.data })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn().mockResolvedValue(1) },
    };
    await runDetectors(db as never, "p1", { now: new Date("2026-11-24T00:00:00Z") });
    const o11 = created.filter((row) => row.type === "O11_freshness_decay");
    expect(o11).toHaveLength(1);
    expect(String(o11[0].dedupKey)).toContain("2026-11-20");
    expect(String(o11[0].dedupKey)).toContain("condos for sale");
    // And the summary states both periods, so the claim can be checked.
    expect(String(o11[0].summary)).toContain("2026-11-20");
    expect(String(o11[0].summary)).toContain("2026-10-23");
  });

  it("produces no candidate for a query whose position did not move", async () => {
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const flat = [
      rank({ id: "prev", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28, position: 9 }),
      rank({ id: "cur", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28, position: 9 }),
    ];
    const created: Array<Record<string, unknown>> = [];
    const db = {
      evidenceRecord: { findMany: vi.fn(async () => flat) },
      demandMapCluster: { findMany: vi.fn().mockResolvedValue([]) },
      site: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => null) },
      auditPage: { findMany: vi.fn(async () => []) },
      opportunity: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { id: "op", ...args.data };
        }),
        update: vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn().mockResolvedValue(1) },
    };
    await runDetectors(db as never, "p1", { now: new Date("2026-11-24T00:00:00Z") });
    expect(created.filter((row) => row.type === "O11_freshness_decay")).toEqual([]);
  });

  it("disables O11 with a reason when only one window exists", async () => {
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const single = [rank({ id: "c", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28, position: 12 })];
    const db = {
      evidenceRecord: { findMany: vi.fn(async () => single) },
      demandMapCluster: { findMany: vi.fn().mockResolvedValue([]) },
      site: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => null) },
      auditPage: { findMany: vi.fn(async () => []) },
      opportunity: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "op", ...args.data })),
        update: vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn().mockResolvedValue(1) },
    };
    const result = await runDetectors(db as never, "p1", { now: new Date("2026-11-24T00:00:00Z") });
    const disabled = result.disabled.find((entry) => entry.type === "O11_freshness_decay");
    // A project with one window must say so, not show an empty board: "nothing declined" and
    // "we cannot tell" are different claims.
    expect(disabled).toBeTruthy();
    expect(disabled?.reason).toContain("Only one rank window");
  });
});

describe("CMP-010 one candidate per observation, even when the query is stored twice", () => {
  /**
   * Measured 2026-11-24 on Susi: `akumal real estate` exists as four `current` rows — two
   * `segments` projections, one of them written twice with an identical position and
   * impression count. All four share one dedup key, so emitting one candidate per row made a
   * run report 45 candidates for 43 observations and only looked right because the row write
   * is idempotent.
   */
  const duplicated = [
    rank({ id: "prev", windowEnd: "2026-10-23", windowRole: "previous", windowDays: 28, position: 14, impressions: 28 }),
    rank({ id: "cur-weak", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28, position: 4, impressions: 13 }),
    rank({ id: "cur-strong", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28, position: 20, impressions: 93 }),
    rank({ id: "cur-strong-copy", windowEnd: "2026-11-20", windowRole: "current", windowDays: 28, position: 20, impressions: 93 }),
  ];

  function detectingDb(seed: Row[]) {
    const created: Array<Record<string, unknown>> = [];
    return {
      created,
      db: {
        evidenceRecord: { findMany: vi.fn(async () => seed) },
        demandMapCluster: { findMany: vi.fn().mockResolvedValue([]) },
        site: { findFirst: vi.fn(async () => null) },
        crawl: { findFirst: vi.fn(async () => null) },
        auditPage: { findMany: vi.fn(async () => []) },
        opportunity: {
          findMany: vi.fn(async () => []),
          findUnique: vi.fn(async () => null),
          create: vi.fn(async (args: { data: Record<string, unknown> }) => {
            created.push(args.data);
            return { id: `op-${created.length}`, ...args.data };
          }),
          update: vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
          updateMany: vi.fn(async () => ({ count: 0 })),
          groupBy: vi.fn().mockResolvedValue([]),
        },
        evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn().mockResolvedValue(1) },
      },
    };
  }

  it("produces one candidate for a query stored under several segments", async () => {
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const { created, db } = detectingDb(duplicated);
    await runDetectors(db as never, "p1", { now: new Date("2026-11-24T00:00:00Z") });
    const o11 = created.filter((row) => row.type === "O11_freshness_decay");
    expect(o11).toHaveLength(1);
  });

  it("keeps the projection with the most impressions, because it carries the most signal", async () => {
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const { created, db } = detectingDb(duplicated);
    await runDetectors(db as never, "p1", { now: new Date("2026-11-24T00:00:00Z") });
    const o11 = created.find((row) => row.type === "O11_freshness_decay")!;
    // 14 → 20 on 93 impressions, not 14 → 4 on 13. Both are stored; the choice is
    // arithmetic on a count, not a judgement about which projection is right.
    expect(String(o11.title)).toContain("14 → 20");
    expect(String(o11.summary)).toContain("93 impressions");
  });
});
