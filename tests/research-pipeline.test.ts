import { describe, expect, it } from "vitest";

import { runResearchPipeline, type PipelineDeps } from "@/lib/research/pipeline";
import type { BundleResult } from "@/lib/research/monthly-bundle";
import type { OpportunitiesStageResult } from "@/lib/research/opportunities-stage";
import type { TopicMapStageResult } from "@/lib/research/topic-map-stage";

/**
 * The pipeline exists to enforce one thing: a stage does not run unless the
 * stage before it produced a usable result. These tests are that rule, stated
 * as cases, because the defect it replaces was not a wrong line — it was that
 * nothing checked.
 */

type RunRow = {
  id: string;
  siteId: string;
  status: string;
  idempotencyKey: string | null;
  createdAt: Date;
  completedAt: Date | null;
  costMicros: number;
  sourceCount: number;
  brief: unknown;
  report: unknown;
};

function fakeDb(runs: RunRow[] = []) {
  return {
    site: {
      findUnique: async () => ({ id: "site-1", domain: "example.test", projectId: "proj-1", retiredAt: null }),
    },
    researchRun: {
      findFirst: async ({ where }: { where: { idempotencyKey?: string } }) =>
        runs.find((run) => run.idempotencyKey === where.idempotencyKey) ?? null,
    },
  } as never;
}

function bundleRun(status = "COMPLETED"): RunRow {
  return {
    id: "bundle-run-1",
    siteId: "site-1",
    status,
    idempotencyKey: "monthly:site-1:2026-11:bundle",
    createdAt: new Date("2026-11-05T05:57:00Z"),
    completedAt: new Date("2026-11-05T05:57:00Z"),
    costMicros: 0,
    sourceCount: 0,
    brief: { month: "2026-11" },
    report: { bundle: { month: "2026-11" } },
  };
}

function topicRun(status = "COMPLETED"): RunRow {
  return {
    id: "map-run-1",
    siteId: "site-1",
    status,
    idempotencyKey: "topic-map:site-1:2026-11",
    createdAt: new Date("2026-11-05T12:20:00Z"),
    completedAt: new Date("2026-11-05T12:20:00Z"),
    costMicros: 0,
    sourceCount: 0,
    brief: { month: "2026-11" },
    report: {},
  };
}

function bundleResult(
  status: BundleResult["status"],
  overrides: Partial<BundleResult> = {}
): BundleResult {
  return {
    status,
    exitCode: 0,
    plan: {} as never,
    runId: "bundle-run-1",
    receipt: null,
    sections: [],
    totalCostMicros: 0,
    paidCalls: 0,
    ...overrides,
  };
}

function topicResult(
  status: TopicMapStageResult["status"],
  overrides: Partial<TopicMapStageResult> = {}
): TopicMapStageResult {
  return { status, runId: "map-run-1", map: null, detail: "topic map", ...overrides };
}

function opportunityResult(
  status: OpportunitiesStageResult["status"],
  overrides: Partial<OpportunitiesStageResult> = {}
): OpportunitiesStageResult {
  return { status, runId: "opp-run-1", detail: "proposals", proposals: [], ...overrides };
}

function deps(overrides: Partial<PipelineDeps> & { calls?: string[] } = {}): PipelineDeps {
  const calls = overrides.calls;
  return {
    bundle: async () => {
      calls?.push("bundle");
      return bundleResult("completed");
    },
    topicMap: async () => {
      calls?.push("topic-map");
      return topicResult("completed");
    },
    opportunities: async () => {
      calls?.push("opportunities");
      return opportunityResult("completed");
    },
    ...overrides,
  } as PipelineDeps;
}

describe("the pipeline re-scores the board it just drafted", () => {
  /** A db whose only job is the re-score: one stale row, and its update recorded. */
  function rescoreDb() {
    const updates: Record<string, unknown>[] = [];
    const db = {
      site: {
        findUnique: async () => ({ id: "site-1", domain: "example.test", projectId: "proj-1", retiredAt: null }),
        findMany: async () => [{ domain: "example.test", projectId: "proj-1" }],
      },
      researchRun: { findFirst: async ({ where }: { where: { idempotencyKey?: string } }) =>
        where.idempotencyKey === "monthly:site-1:2026-11:bundle" ? bundleRun() : where.idempotencyKey === "topic-map:site-1:2026-11" ? topicRun() : null },
      demandMapCluster: { count: async () => 1 },
      opportunity: {
        findMany: async () => [
          {
            id: "op-1",
            title: "New Spanish article: apnea as a sport",
            status: "detected",
            // Written when the row had no measured reach; its inputs have since improved.
            scoreValue: 1,
            scoreInputs: {
              worth: { volume: 1300, businessValue: 0.85, businessValueSource: "cluster", measurement: "observed_baseline" },
              effort: { sizeFactor: 1, playTypeBase: 8 },
              freshness: 0.9,
              stability: 0.8,
              evidenceCompleteness: "both",
              winProbability: { playTypeFactor: 0.6 },
              winProbabilitySource: { playTypeFactor: "assumed" },
            },
          },
        ],
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        },
      },
    };
    return { db: db as never, updates };
  }

  it("recomputes scoreValue when the pipeline drafted work", async () => {
    // The drafting stage writes `scoreValue` once. A bundle that just supplied
    // impressions changes what that score should be, and nothing else would recompute
    // it — so a board read seconds later would be stale.
    const { db, updates } = rescoreDb();
    const result = await runResearchPipeline(db, {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps(),
    });

    expect(result.stages[2].status).toBe("completed");
    expect(updates).toHaveLength(1);
    expect(updates[0].scoreValue).toBeGreaterThan(1);
    expect(result.stages[2].detail).toContain("re-scored 1 opportunity");
  });

  it("reports the movement on the stage, so it is visible rather than silent", async () => {
    const { db } = rescoreDb();
    const result = await runResearchPipeline(db, {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps(),
    });
    expect(result.stages[2].detail).toMatch(/largest \+\d+ on "New Spanish article/);
  });

  it("does not fail the pipeline when the re-score cannot run", async () => {
    // Work was drafted; the board is merely stale, and the nightly sweep is the
    // backstop. Failing the run would throw away a completed stage for a derived number.
    const db = {
      site: {
        findUnique: async () => ({ id: "site-1", domain: "example.test", projectId: "proj-1", retiredAt: null }),
        findMany: async () => [{ domain: "example.test", projectId: "proj-1" }],
      },
      researchRun: { findFirst: async ({ where }: { where: { idempotencyKey?: string } }) =>
        where.idempotencyKey === "monthly:site-1:2026-11:bundle" ? bundleRun() : where.idempotencyKey === "topic-map:site-1:2026-11" ? topicRun() : null },
      demandMapCluster: { count: async () => 1 },
      opportunity: {
        findMany: async () => {
          throw new Error("connection reset");
        },
        update: async () => ({}),
      },
    } as never;

    const result = await runResearchPipeline(db, {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps(),
    });
    expect(result.stages[2].status).toBe("completed");
    expect(result.blockedBy).toBeNull();
    expect(result.stages[2].detail).toContain("re-score failed");
  });
});

describe("the research pipeline gate", () => {
  it("runs the three stages in order when the bundle completes", async () => {
    const calls: string[] = [];
    const result = await runResearchPipeline(fakeDb(), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps({ calls }),
    });

    expect(calls).toEqual(["bundle", "topic-map", "opportunities"]);
    expect(result.stages.map((stage) => stage.stage)).toEqual(["bundle", "topic-map", "opportunities"]);
    expect(result.stages.map((stage) => stage.status)).toEqual(["completed", "completed", "completed"]);
    expect(result.blockedBy).toBeNull();
  });

  it("does not run the topic map when the bundle is partial", async () => {
    const calls: string[] = [];
    const result = await runResearchPipeline(fakeDb(), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps({
        calls,
        bundle: async () => {
          calls.push("bundle");
          return bundleResult("partial", { error: "aeo section failed" });
        },
      }),
    });

    expect(calls).toEqual(["bundle"]);
    expect(result.blockedBy).toBe("bundle");
    expect(result.stages.map((stage) => stage.status)).toEqual(["partial", "blocked", "blocked"]);
    expect(result.stages[0].detail).toContain("aeo section failed");
    expect(result.stages[1].detail).toContain("not run");
  });

  it("continues past a partial bundle only when the caller asks for it", async () => {
    const calls: string[] = [];
    const result = await runResearchPipeline(fakeDb(), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      allowPartial: true,
      deps: deps({
        calls,
        bundle: async () => {
          calls.push("bundle");
          return bundleResult("partial");
        },
      }),
    });

    expect(calls).toEqual(["bundle", "topic-map", "opportunities"]);
    // The partial is still reported; the gate was crossed on purpose, not by accident.
    expect(result.stages[0].status).toBe("partial");
    expect(result.blockedBy).toBeNull();
  });

  it("stops when the bundle fails", async () => {
    const calls: string[] = [];
    const result = await runResearchPipeline(fakeDb(), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps({
        calls,
        bundle: async () => {
          calls.push("bundle");
          return bundleResult("failed", { error: "no credentials" });
        },
      }),
    });

    expect(calls).toEqual(["bundle"]);
    expect(result.blockedBy).toBe("bundle");
    expect(result.stages[0].status).toBe("failed");
  });

  it("buys nothing and runs nothing else when execute has no approval", async () => {
    const calls: string[] = [];
    const result = await runResearchPipeline(fakeDb(), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      deps: deps({ calls }),
    });

    expect(calls).toEqual([]);
    expect(result.blockedBy).toBe("bundle");
    expect(result.stages).toHaveLength(3);
    expect(result.stages[0].status).toBe("blocked");
    expect(result.stages[0].detail).toContain("approval");
    expect(result.stages[1].status).toBe("blocked");
  });

  it("reuses a completed bundle without buying it again", async () => {
    const calls: string[] = [];
    const result = await runResearchPipeline(fakeDb([bundleRun()]), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps({ calls }),
    });

    expect(calls).toEqual(["topic-map", "opportunities"]);
    expect(result.stages[0].status).toBe("skipped");
    expect(result.stages[0].runId).toBe("bundle-run-1");
    expect(result.blockedBy).toBeNull();
  });

  it("does not draft proposals when the topic map fails", async () => {
    const calls: string[] = [];
    const result = await runResearchPipeline(fakeDb([bundleRun()]), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps({
        calls,
        topicMap: async () => {
          calls.push("topic-map");
          return topicResult("failed", { runId: null, detail: "no job map" });
        },
      }),
    });

    expect(calls).toEqual(["topic-map"]);
    expect(result.blockedBy).toBe("topic-map");
    expect(result.stages[1].status).toBe("failed");
    expect(result.stages[1].detail).toBe("no job map");
  });

  it("treats a reused map as satisfying the gate, and says so", async () => {
    const calls: string[] = [];
    const result = await runResearchPipeline(fakeDb([bundleRun(), topicRun()]), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps({
        calls,
        topicMap: async () => {
          calls.push("topic-map");
          return topicResult("skipped", { detail: "existing topic map returned without rebuilding" });
        },
      }),
    });

    expect(calls).toEqual(["topic-map", "opportunities"]);
    expect(result.stages[1].status).toBe("skipped");
    expect(result.blockedBy).toBeNull();
  });

  it("reports a stage that did not run as blocked rather than leaving it out", async () => {
    const result = await runResearchPipeline(fakeDb([bundleRun()]), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps({
        topicMap: async () => topicResult("failed", { runId: null, detail: "job map proposal failed" }),
      }),
    });

    // The stage that would have run is still in the list, so a reader sees the
    // pipeline stop instead of a shorter pipeline that looks complete.
    expect(result.stages).toHaveLength(3);
    expect(result.stages.map((stage) => stage.stage)).toEqual(["bundle", "topic-map", "opportunities"]);
    expect(result.stages[2].status).toBe("blocked");
    expect(result.stages[2].detail).toContain("topic-map");
  });

  it("spends nothing in dry run, and says which stages would cost a call", async () => {
    const calls: string[] = [];
    const result = await runResearchPipeline(fakeDb(), {
      siteId: "site-1",
      month: "2026-11",
      mode: "dry-run",
      deps: deps({
        calls,
        bundle: async () => {
          calls.push("bundle");
          return bundleResult("planned");
        },
      }),
    });

    expect(calls).toEqual(["bundle"]);
    expect(result.stages).toHaveLength(3);
    // The map and proposals are model calls; a dry run reports them and does not start them.
    expect(result.stages[1].status).toBe("blocked");
    expect(result.stages[1].detail).toContain("model call");
    expect(result.stages[2].status).toBe("blocked");
  });

  it("reports a site that cannot even plan a bundle instead of throwing past it", async () => {
    const result = await runResearchPipeline(fakeDb(), {
      siteId: "site-1",
      month: "2026-11",
      mode: "dry-run",
      deps: deps({
        bundle: async () => {
          throw new Error("the site has no audience market or country; pass --country");
        },
      }),
    });

    expect(result.blockedBy).toBe("bundle");
    expect(result.stages[0].status).toBe("failed");
    expect(result.stages[0].detail).toContain("no audience market or country");
    expect(result.stages[1].status).toBe("blocked");
  });

  it("reports a refused bundle rather than throwing, on execute too", async () => {
    const result = await runResearchPipeline(fakeDb(), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      deps: deps({
        bundle: async () => {
          throw new Error("estimated $0.3100 exceeds the bundle cap $0.3000");
        },
      }),
    });

    expect(result.stages[0].status).toBe("failed");
    expect(result.stages[0].detail).toContain("bundle cap");
    expect(result.blockedBy).toBe("bundle");
  });

  it("rebuilds the map on refresh without re-buying a completed bundle", async () => {
    // Repairing a map that was built before its data must not spend provider
    // money to prove a point. `refresh` is the model-call rebuild; only
    // `refreshBundle` re-buys.
    const calls: string[] = [];
    let bundleCalled = false;
    const result = await runResearchPipeline(fakeDb([bundleRun()]), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      refresh: true,
      deps: deps({
        calls,
        bundle: async () => {
          bundleCalled = true;
          calls.push("bundle");
          return bundleResult("completed");
        },
      }),
    });

    expect(bundleCalled).toBe(false);
    expect(calls).toEqual(["topic-map", "opportunities"]);
    expect(result.stages[0].status).toBe("skipped");
    expect(result.stages[1].status).toBe("completed");
  });

  it("re-buys the bundle only when refreshBundle is set", async () => {
    const calls: string[] = [];
    await runResearchPipeline(fakeDb([bundleRun()]), {
      siteId: "site-1",
      month: "2026-11",
      mode: "execute",
      approval: "owner-ref",
      refreshBundle: true,
      deps: deps({ calls }),
    });
    expect(calls).toEqual(["bundle", "topic-map", "opportunities"]);
  });

  it("rejects a malformed month before touching anything", async () => {
    await expect(
      runResearchPipeline(fakeDb(), { siteId: "site-1", month: "November", mode: "dry-run", deps: deps() })
    ).rejects.toThrow(/YYYY-MM/);
  });
});
