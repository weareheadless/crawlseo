import { describe, expect, it, vi } from "vitest";

import { acceptOpportunityIntoTask, applyJoin, computeFollowUps, confirmHumanStep, recordAgentPreparation, recordDeliveryOutcome } from "@/lib/funnel/join";
import { upsertOpportunity } from "@/lib/funnel/opportunity";

const scoreInputs = {
  worth: { volume: 400, ctrAtPosition: 0.04, businessValue: 0.7 },
  winProbability: { rankDistance: 0.75, authorityGap: 0.6, pageStrength: 0.5, serpCompetition: 0.5, playTypeFactor: 0.6 },
  effort: { playTypeBase: 6, sizeFactor: 1 },
  freshness: 1,
  stability: 0.8,
};

const opportunityDb = () => {
  const store = new Map<string, Record<string, unknown>>();
  const db = {
    opportunity: {
      findUnique: vi.fn(async (args: { where: { id: string } | { projectId_dedupKey: { dedupKey: string } } }) => {
        if ("id" in args.where) return store.get(args.where.id) ?? null;
        for (const row of store.values()) if (row.dedupKey === args.where.projectId_dedupKey.dedupKey) return row;
        return null;
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const record = { id: `op-${store.size + 1}`, status: "detected", ...args.data };
        store.set(record.id as string, record);
        return record;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = store.get(args.where.id) as Record<string, unknown>;
        Object.assign(record, args.data);
        return record;
      }),
      findMany: vi.fn(async () => [...store.values()]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    evidenceEdge: {
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({ id: `edge-${args.create.fromId}-${args.create.toId}` })),
      count: vi.fn().mockResolvedValue(2),
    },
    evidenceRecord: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { db, store };
};

describe("task gate (wave 2)", () => {
  it("a task cannot be created without an opportunity", async () => {
    const { db } = opportunityDb();
    (db.opportunity.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      acceptOpportunityIntoTask(db as never, "missing", { title: "Fix page", assignedTo: "dana" })
    ).rejects.toThrow(/opportunity not found/);
  });

  it("a task cannot exist without a human executor", async () => {
    const { db, store } = opportunityDb();
    store.set("op1", { id: "op1", status: "detected", dedupKey: "d1" });
    await expect(
      acceptOpportunityIntoTask(db as never, "op1", { title: "Fix page", assignedTo: "  " })
    ).rejects.toThrow(/human executor/);
  });

  it("accepting an opportunity creates the task at the single gate and moves the opportunity to accepted", async () => {
    const { db, store } = opportunityDb();
    store.set("op1", { id: "op1", status: "detected", dedupKey: "d1" });
    const tasks: Record<string, unknown>[] = [];
    (db as unknown as { task: { create: ReturnType<typeof vi.fn> } }).task = {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        tasks.push({ id: "task-1", ...args.data });
        return { id: "task-1" };
      }),
    };
    const taskId = await acceptOpportunityIntoTask(db as never, "op1", { title: "Rewrite title", assignedTo: "dana" });
    expect(taskId).toBe("task-1");
    expect(tasks[0]).toMatchObject({ opportunityId: "op1", assignedTo: "dana", status: "todo" });
    expect(store.get("op1")).toMatchObject({ status: "accepted" });
  });

  it("human confirmations are recorded distinctly from agent preparation", async () => {
    const { db } = opportunityDb();
    const updated: unknown[] = [];
    (db as unknown as { task: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> } }).task = {
      update: vi.fn(async (args: { data: unknown; where: { id: string } }) => {
        updated.push(args.data);
        return { id: args.where.id };
      }),
      findUnique: vi.fn().mockResolvedValue({ status: "in_progress" }),
    };
    await confirmHumanStep(db as never, "t1", { status: "delivered", confirmedBy: "dana" });
    expect(updated[0]).toMatchObject({ status: "delivered", humanConfirmedBy: "dana" });
    await expect(
      confirmHumanStep(db as never, "t1", { status: "delivered", confirmedBy: " " })
    ).rejects.toThrow(/human confirmation requires a name/);
  });

  it("agent-prepared artifacts land in awaiting_human with the agent identity, never auto-delivered", async () => {
    const { db } = opportunityDb();
    const updated: unknown[] = [];
    (db as unknown as { task: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> } }).task = {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updated.push(args.data);
        return { id: "t1" };
      }),
      findUnique: vi.fn().mockResolvedValue({ status: "todo" }),
    };
    await recordAgentPreparation(db as never, "t1", { agentId: "agent-7", plan: { steps: ["rewrite title"] } });
    expect(updated[0]).toMatchObject({
      status: "awaiting_human",
      agentPreparedById: "agent-7",
    });
    expect((updated[0] as Record<string, unknown>).humanConfirmedBy).toBeUndefined();
    expect((updated[0] as Record<string, unknown>).humanConfirmedAt).toBeUndefined();
    await expect(
      recordAgentPreparation(db as never, "t1", { agentId: " ", plan: {} })
    ).rejects.toThrow(/agent identity/);
    (db as unknown as { task: { findUnique: ReturnType<typeof vi.fn> } }).task.findUnique.mockResolvedValue({ status: "delivered" });
    await expect(
      recordAgentPreparation(db as never, "t1", { agentId: "agent-7", plan: {} })
    ).rejects.toThrow(/delivered task/);
  });
});

describe("measurement spine (wave 3)", () => {
  it("an outcome requires a pre-delivery baseline", async () => {
    const db = { outcomeObservation: { create: vi.fn() }, task: { update: vi.fn() } };
    await expect(
      recordDeliveryOutcome(db as never, {
        taskId: "t1",
        baseline: { metrics: {}, observedAt: new Date("2026-11-03T00:00:00.000Z") },
        after: { metrics: {}, observedAt: new Date("2026-11-02T00:00:00.000Z") },
        verdict: "verified_win",
        measuredBy: "rank-tracking",
      })
    ).rejects.toThrow(/pre-delivery baseline/);
    expect(db.outcomeObservation.create).not.toHaveBeenCalled();
  });

  it("outcomes round-trip with all four verdicts and move the task accordingly", async () => {
    const created: unknown[] = [];
    const db = {
      outcomeObservation: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { id: `obs-${created.length}` };
        }),
      },
      task: { update: vi.fn().mockResolvedValue({}) },
    };
    const baseline = { metrics: { "provider:position": { value: 9, unit: "rank" } }, observedAt: new Date("2026-11-01T00:00:00.000Z") };
    for (const verdict of ["verified_win", "no_effect", "regression", "unmeasured"] as const) {
      await recordDeliveryOutcome(db as never, {
        taskId: "t1",
        baseline,
        after: { metrics: { "provider:position": { value: 4, unit: "rank" } }, observedAt: new Date("2026-11-10T00:00:00.000Z") },
        verdict,
        measuredBy: "rank-tracking",
      });
    }
    expect(created).toHaveLength(4);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1" }, data: expect.objectContaining({ status: "verified_outcome" }) })
    );
  });
});

describe("missing-leg join (wave 1)", () => {
  it("computes follow-up collection for one-legged opportunities", async () => {
    const { db, store } = opportunityDb();
    store.set("op1", { id: "op1", status: "detected", type: "O13_user_pain_point", evidenceCompleteness: "why", dedupKey: "d" });
    const followUps = await computeFollowUps(db as never, "p1");
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ missingLeg: "how", collection: /keyword validation/ });
  });

  it("applying a join upgrades the score and completeness", async () => {
    const { db, store } = opportunityDb();
    store.set("op1", {
      id: "op1",
      status: "detected",
      type: "O13_user_pain_point",
      evidenceCompleteness: "why",
      dedupKey: "d",
      title: "t",
      summary: "s",
      dimension: "content",
      detectedBy: "x",
    });
    const { scoreValue, evidenceCompleteness } = await applyJoin(
      db as never,
      "op1",
      { id: "e-new", observedAt: new Date(), metrics: {}, dimensions: {} },
      "how",
      scoreInputs,
      { joinedBy: "funnel-join" }
    );
    expect(evidenceCompleteness).toBe("both");
    expect(scoreValue).toBeGreaterThan(0);
    expect(store.get("op1")).toMatchObject({ evidenceCompleteness: "both" });
  });
});

describe("opportunity store (wave 1)", () => {
  it("rejects an opportunity with no supporting evidence (no orphans)", async () => {
    const { db } = opportunityDb();
    await expect(
      upsertOpportunity(db as never, {
        projectId: "p1",
        type: "O1_winnable_rank",
        dimension: "seo",
        title: "t",
        summary: "s",
        dedupKey: "d1",
        detectedBy: "test",
        scoreInputs,
        whyEvidenceIds: [],
        howEvidenceIds: [],
      })
    ).rejects.toThrow(/no supporting evidence/);
  });

  it("enforces the fixed type→dimension mapping", async () => {
    const { db } = opportunityDb();
    await expect(
      upsertOpportunity(db as never, {
        projectId: "p1",
        type: "O4_aeo_citation_gap",
        dimension: "seo",
        title: "t",
        summary: "s",
        dedupKey: "d2",
        detectedBy: "test",
        scoreInputs,
        whyEvidenceIds: ["e1"],
        howEvidenceIds: [],
      })
    ).rejects.toThrow(/fixed dimension/);
  });
});

describe("join measurement", () => {
  it("rebuilds the demand inputs from an arriving volume measurement", async () => {
    const { assessmentOverridesFromEvidence } = await import("@/lib/funnel/join");
    const overrides = assessmentOverridesFromEvidence({
      id: "e1",
      observedAt: new Date(),
      dimensions: { query: "closing costs" },
      metrics: { "provider:volume": { value: 480, unit: "searches/month", source: "provider" } },
    });
    expect(overrides).toEqual({ volume: 480, volumeSource: "provider" });
  });

  it("changes nothing when the evidence carries no measurement", async () => {
    const { assessmentOverridesFromEvidence } = await import("@/lib/funnel/join");
    expect(assessmentOverridesFromEvidence({ id: "e2", observedAt: new Date(), dimensions: {}, metrics: {} })).toEqual({});
  });
});

describe("task brief", () => {
  it("carries the decision into the accepted task", async () => {
    const { taskPlanFromOpportunity } = await import("@/lib/funnel/join");
    const plan = taskPlanFromOpportunity({
      title: "Customers cannot tell what a fitted wardrobe costs",
      summary: "Homeowners ask about cost before booking a survey.",
      scoreInputs: {
        worth: {
          readiness: "actionable",
          intervention: "update_page",
          benefitTrack: "customer_value",
          measurement: "unquantified",
          change: "Update /services so it answers the cost question",
          successMeasure: "the page answers the question in an owner review",
          targetPages: ["https://site.test/services"],
          coverageSummary: "partially answers at https://site.test/services",
          needRationale: "three homeowners asked before booking",
          needEvidenceUrls: ["https://forum.test/wardrobe-cost"],
          offerFitRationale: "the business makes fitted wardrobes",
          offerFitEvidenceUrls: ["https://site.test/services"],
          assessmentModel: "fixture-model",
        },
      },
    });
    expect(plan.readiness).toBe("actionable");
    expect(plan.targetPages).toEqual(["https://site.test/services"]);
    expect(plan.change).toContain("/services");
    expect(plan.successMeasure).toContain("owner review");
    expect(plan.measurement).toBe("unquantified");
    expect(plan.needRationale).toContain("homeowners");
    expect(plan.needEvidenceUrls).toEqual(["https://forum.test/wardrobe-cost"]);
    expect(plan.assessmentModel).toBe("fixture-model");
  });

  it("still produces a brief for a legacy row without a decision", async () => {
    const { taskPlanFromOpportunity } = await import("@/lib/funnel/join");
    const plan = taskPlanFromOpportunity({ title: "t", summary: "s", scoreInputs: {} });
    expect(plan.readiness).toBeNull();
    expect(plan.targetPages).toEqual([]);
  });
});
