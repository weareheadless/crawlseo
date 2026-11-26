import { describe, expect, it, vi } from "vitest";

import { capabilitiesOwnedBy } from "@/lib/funnel/capabilities";

/**
 * A producer may only change the state of rows for capabilities it owns.
 *
 * ## The defect
 *
 * Ownership of the opportunity board was inferred, never declared. `refreshFunnelForSite` read
 * "one board per project" as "the topic map owns the board, so the detectors do not run" and
 * returned early. Measured 2026-11-25: all 8 tenants had modelled clusters, so `runDetectors`
 * had not run in production for any of them, and the 9 capabilities only the detectors can
 * express had no producer at all. The retirement sweep then parked 109 rows of that unowned
 * work as "superseded by the topic-map pipeline", and every run reported success.
 *
 * Meanwhile the state transitions were unscoped in the other direction: `applyHysteresis` and
 * `applyOpenCap` queried every `detected` row in the project and used `detectedBy` only to label
 * the park. So whichever producer ran could evict — and unpark — another producer's work. The
 * cap ordered the whole board and parked whatever fell past 100, which means turning one
 * producer back on could delete the other's rows to make room.
 *
 * ## The rule these tests hold
 *
 * Ownership is a property of the capability, not of the writer, and it is declared once in
 * `CAPABILITY_PRODUCER`. Both the park and the restore leg are bounded by it.
 */

function mockDb(rows: Array<Record<string, unknown>>) {
  const found: Array<Record<string, unknown>> = [];
  const parked: string[] = [];
  const restored: string[] = [];
  const db = {
    opportunity: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        found.push(args);
        return rows;
      }),
      update: vi.fn(async (args: { where: { id: string } }) => {
        parked.push(args.where.id);
        return { id: args.where.id };
      }),
      updateMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        restored.push(...args.where.id.in);
        return { count: args.where.id.in.length };
      }),
    },
  };
  return { db, found, parked, restored };
}

const DETECTOR_TYPES = capabilitiesOwnedBy("detectors");
const TOPIC_MAP_TYPES = capabilitiesOwnedBy("topic-map");

describe("hysteresis is bounded by capability ownership", () => {
  it("parks and restores only the capabilities the run owns", async () => {
    const { applyHysteresis } = await import("@/lib/funnel/opportunity");
    const { db, found } = mockDb([]);
    await applyHysteresis(db as never, {
      projectId: "p1",
      threshold: 3,
      detectedBy: "funnel-refresh",
      ownedTypes: DETECTOR_TYPES,
    });
    // Two legs: park the drifting rows, restore the recovered ones. Both bounded.
    expect(found).toHaveLength(2);
    for (const call of found) {
      const where = call.where as Record<string, unknown>;
      expect((where.type as { in: string[] }).in).toEqual(DETECTOR_TYPES);
    }
  });

  it("does not reach the topic map's capabilities when the detectors run", async () => {
    const { applyHysteresis } = await import("@/lib/funnel/opportunity");
    const { db, found } = mockDb([]);
    await applyHysteresis(db as never, {
      projectId: "p1",
      threshold: 3,
      detectedBy: "funnel-refresh",
      ownedTypes: DETECTOR_TYPES,
    });
    for (const call of found) {
      const types = ((call.where as Record<string, unknown>).type as { in: string[] }).in;
      for (const owned of TOPIC_MAP_TYPES) expect(types).not.toContain(owned);
    }
  });

  it("still restores a row whose score recovered, which is why the bound is not a one-way door", async () => {
    const { applyHysteresis } = await import("@/lib/funnel/opportunity");
    const { db, found, restored } = mockDb([
      { id: "came-back", scoreValue: 7, scoreInputs: null, recommendationDecision: null },
    ]);
    await applyHysteresis(db as never, {
      projectId: "p1",
      threshold: 3,
      detectedBy: "funnel-refresh",
      ownedTypes: DETECTOR_TYPES,
    });
    // The second leg is the restore; a bounded sweep must not become a park-only sweep.
    expect((found[1].where as Record<string, unknown>).status).toBe("parked");
    expect(restored).toEqual(["came-back"]);
  });
});

describe("the open cap is bounded by capability ownership", () => {
  it("counts only its own rows, so it cannot evict another producer's work", async () => {
    const { applyOpenCap } = await import("@/lib/funnel/detectors");
    const { db, found } = mockDb([]);
    await applyOpenCap(db as never, {
      projectId: "p1",
      cap: 100,
      detectedBy: "funnel-refresh",
      ownedTypes: DETECTOR_TYPES,
    });
    const where = found[0].where as Record<string, unknown>;
    expect((where.type as { in: string[] }).in).toEqual(DETECTOR_TYPES);
  });
});

describe("a modelled project still runs the detectors", () => {
  /**
   * The regression that deleted nine capabilities.
   *
   * "The topic map owns the board" must mean "the topic map owns its capabilities", not "the
   * detectors do not run". A dry run over a modelled project has to produce candidates for the
   * detector-owned types, and must not produce any for the topic map's.
   */
  it("produces the capabilities it owns and none of the topic map's", async () => {
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const created: Array<Record<string, unknown>> = [];
    const db = {
      evidenceRecord: { findMany: vi.fn(async () => []) },
      demandMapCluster: { findMany: vi.fn(async () => []) },
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
        update: vi.fn(async () => ({ id: "x" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        groupBy: vi.fn(async () => []),
      },
      evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn(async () => 1) },
    };
    const result = await runDetectors(db as never, "p1", { dryRun: true, topicMapOwnsBoard: true });
    // Nothing to detect from empty evidence — the point is what it *reports* it could not run.
    const reportedDisabled = result.disabled.map((entry) => entry.type);
    for (const type of TOPIC_MAP_TYPES) expect(reportedDisabled).not.toContain(type);
    // Every detector-owned capability with no evidence is reported, not silently absent.
    expect(reportedDisabled.length).toBeGreaterThan(0);
  });

  it("reports the missing input by name, so absence is a number rather than silence", async () => {
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const db = {
      evidenceRecord: { findMany: vi.fn(async () => []) },
      demandMapCluster: { findMany: vi.fn(async () => []) },
      site: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => null) },
      auditPage: { findMany: vi.fn(async () => []) },
      opportunity: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "x" })),
        update: vi.fn(async () => ({ id: "x" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        groupBy: vi.fn(async () => []),
      },
      evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn(async () => 1) },
    };
    const result = await runDetectors(db as never, "p1", { dryRun: true, topicMapOwnsBoard: true });
    const backlink = result.disabled.find((entry) => entry.type === "O9_backlink_gap");
    expect(backlink).toBeTruthy();
    expect(backlink!.missing).toEqual(["backlink_profile"]);
  });

  it("bootstraps every capability for a project the topic map has not modelled", async () => {
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const db = {
      evidenceRecord: { findMany: vi.fn(async () => []) },
      demandMapCluster: { findMany: vi.fn(async () => []) },
      site: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => null) },
      auditPage: { findMany: vi.fn(async () => []) },
      opportunity: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "x" })),
        update: vi.fn(async () => ({ id: "x" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        groupBy: vi.fn(async () => []),
      },
      evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn(async () => 1) },
    };
    const result = await runDetectors(db as never, "p1", { dryRun: true, topicMapOwnsBoard: false });
    const reported = result.disabled.map((entry) => entry.type);
    // With no evidence at all, all 14 are reported as unable to run — including the topic map's,
    // because nothing has modelled them either. An unmodelled tenant gets an honest report, not
    // an empty board that reads as "nothing to do".
    expect(reported).toHaveLength(14);
  });
});

describe("a dry run writes nothing", () => {
  /**
   * `dryRun` skipped creating and updating rows but still ran every sweep, so a "shadow"
   * comparison parked the rows already on the board. Measured 2026-11-25 on susimacdonald: a dry
   * run taken to measure what turning the detectors back on would do parked 35 live rows as
   * `superseded` — and `superseded` is deliberately not restorable, so nothing brought them back.
   *
   * A flag named `dryRun` that writes is worse than no flag: it invites the confident read-only
   * measurement that damages production. Every writer in the run is asserted absent here.
   */
  it("performs no update, no updateMany and no create", async () => {
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const calls: string[] = [];
    const seed = [
      {
        id: "r1",
        kind: "keyword_rank",
        observedAt: new Date("2026-11-20T00:00:00Z"),
        dimensions: { query: "pricing software", url: "https://x.com/a", windowEnd: "2026-11-20T00:00:00.000Z", windowDays: 28, windowRole: "current", scope: "all" },
        metrics: {
          "first_party:position": { value: 8, unit: "rank", source: "first_party" },
          "first_party:impressions": { value: 400, unit: "count", source: "first_party" },
          "first_party:clicks": { value: 4, unit: "count", source: "first_party" },
          "first_party:ctr": { value: 0.01, unit: "ratio", source: "first_party" },
        },
      },
    ];
    const db = {
      evidenceRecord: { findMany: vi.fn(async () => seed) },
      demandMapCluster: { findMany: vi.fn(async () => []) },
      site: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => null) },
      auditPage: { findMany: vi.fn(async () => []) },
      opportunity: {
        // A row already on the board, which the sweeps would reach for.
        findMany: vi.fn(async () => [
          { id: "existing", type: "O2_striking_distance", dedupKey: "O2:some other query", status: "detected", scoreValue: 1, scoreInputs: null, recommendationDecision: null },
        ]),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => {
          calls.push("create");
          return { id: "new" };
        }),
        update: vi.fn(async () => {
          calls.push("update");
          return { id: "x" };
        }),
        updateMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
          calls.push("updateMany");
          return { count: 0 };
        }),
        groupBy: vi.fn(async () => []),
      },
      evidenceEdge: {
        upsert: vi.fn(async () => {
          calls.push("evidenceEdge.upsert");
          return { id: "edge" };
        }),
        count: vi.fn(async () => 1),
      },
    };
    const result = await runDetectors(db as never, "p1", { dryRun: true, topicMapOwnsBoard: true });
    expect(calls).toEqual([]);
    // And it still reports what it would have produced, which is the point of a dry run.
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(result.parked).toEqual([]);
  });
});
