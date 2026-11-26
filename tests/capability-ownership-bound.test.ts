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

describe("no producer path can reach a capability it does not own", () => {
  /**
   * The ownership filter on the `DETECTORS` loop is not sufficient on its own.
   *
   * `clusterPlayDetector` emits `O3_content_gap` and runs *outside* that loop, so the filter
   * never saw it. It put O3 into `produced`, which is the map `retireStaleDetected` reads to
   * decide what is stale — and the sweep then parked 15 of the topic map's own content-gap rows
   * on susimacdonald, scoring 29, 33 and 21. The highest-value work on the board, removed by a
   * run that does not own the capability.
   *
   * The bound therefore sits in `remember`, the single place a candidate joins the run's output.
   * This test drives a real (non-dry) run against a board that already holds a topic-map O3 row
   * and asserts nothing parks it. It is deliberately an end-to-end assertion rather than a unit
   * test of `remember`, because the defect was a second producer path, and only the whole run
   * can show that no path exists.
   */
  it("leaves the topic map's content-gap rows alone when the detectors run", async () => {
    const { runDetectors } = await import("@/lib/funnel/detectors");
    const parkedIds: string[] = [];
    /**
     * A cluster whose coverage is low enough that `clusterPlayDetector` *does* emit an
     * `O3_content_gap` candidate.
     *
     * Seeding this is what makes the test mean anything. With no clusters, that detector emits
     * nothing, O3 never approaches `produced`, and the assertion passes whether or not the
     * ownership bound exists — a vacuous test guarding a real defect. Three membership rows with
     * no ranked query gives coverage 0, under the 0.34 ceiling, so the candidate is produced and
     * the bound has to stop it.
     */
    const clusterEvidence = [
      { id: "m1", kind: "keyword_universe_membership", observedAt: new Date("2026-11-20T00:00:00Z"), dimensions: { cluster: "cozumel-buying", query: "cozumel condos" }, metrics: {} },
      { id: "m2", kind: "keyword_universe_membership", observedAt: new Date("2026-11-20T00:00:00Z"), dimensions: { cluster: "cozumel-buying", query: "cozumel real estate" }, metrics: {} },
      { id: "m3", kind: "keyword_universe_membership", observedAt: new Date("2026-11-20T00:00:00Z"), dimensions: { cluster: "cozumel-buying", query: "buy in cozumel" }, metrics: {} },
    ];
    const db = {
      evidenceRecord: {
        findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
          const kind = ((args?.where ?? {}) as Record<string, unknown>).kind;
          return kind === "keyword_universe_membership" ? clusterEvidence : [];
        }),
      },
      demandMapCluster: {
        findMany: vi.fn(async () => [{ id: "c1", slug: "cozumel-buying", name: "Cozumel buying", projectId: "p1" }]),
      },
      site: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => null) },
      auditPage: { findMany: vi.fn(async () => []) },
      opportunity: {
        /**
         * One high-scoring row owned by the topic map, returned to whichever sweep asks for it.
         *
         * The `where` clause is honoured rather than ignored. A mock that returns the row to every
         * caller proves nothing: `applyHysteresis` filters on `type: { in: ownedTypes }`, so
         * returning an O3 row to it fabricates a reach the real query cannot make, and the test
         * fails on the mock instead of on the bound.
         */
        findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
          const row = {
            id: "topic-map-row",
            type: "O3_content_gap",
            dedupKey: "phase3:content_business:222c0acb67f97f50",
            status: "detected",
            scoreValue: 29,
            scoreInputs: null,
            recommendationDecision: null,
          };
          const where = (args?.where ?? {}) as Record<string, unknown>;
          const typeFilter = where.type as { in?: string[]; notIn?: string[] } | undefined;
          if (typeFilter?.in && !typeFilter.in.includes(row.type)) return [];
          if (typeFilter?.notIn && typeFilter.notIn.includes(row.type)) return [];
          if (where.status !== undefined && where.status !== row.status) return [];
          const score = where.scoreValue as { lt?: number; gte?: number } | undefined;
          if (score?.lt !== undefined && !(row.scoreValue < score.lt)) return [];
          if (score?.gte !== undefined && !(row.scoreValue >= score.gte)) return [];
          const key = where.dedupKey as { in?: string[] } | undefined;
          if (key?.in && !key.in.includes(row.dedupKey)) return [];
          return [row];
        }),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "new" })),
        update: vi.fn(async (args: { where: { id: string } }) => {
          parkedIds.push(args.where.id);
          return { id: args.where.id };
        }),
        updateMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
          parkedIds.push(...args.where.id.in);
          return { count: args.where.id.in.length };
        }),
        groupBy: vi.fn(async () => []),
      },
      evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn(async () => 1) },
    };
    const result = await runDetectors(db as never, "p1", { topicMapOwnsBoard: true, detectedBy: "funnel-refresh" });
    // The bound, and proof the detector really did try: `clusterPlayDetector` produced the
    // candidate (it is in the run's output path) but it never became a row or a stale-sweep claim.
    expect(result.created).toBe(0);
    expect(parkedIds).not.toContain("topic-map-row");
  });

  it("produces no candidate for a capability owned by the topic map", async () => {
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
        create: vi.fn(async () => ({ id: "new" })),
        update: vi.fn(async () => ({ id: "x" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        groupBy: vi.fn(async () => []),
      },
      evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn(async () => 1) },
    };
    const result = await runDetectors(db as never, "p1", { dryRun: true, topicMapOwnsBoard: true });
    for (const candidate of result.candidates ?? []) {
      expect(TOPIC_MAP_TYPES).not.toContain(candidate.type);
    }
  });
});
