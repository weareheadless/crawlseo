import { describe, expect, it, vi } from "vitest";

import { runDetectors } from "@/lib/funnel/detectors";
import { acceptOpportunityIntoTask, confirmHumanStep, recordDeliveryOutcome } from "@/lib/funnel/join";

/**
 * Wave 6 ports the requirement the retired crawl-action lifecycle test encoded:
 * a crawl gap must still become trackable work with a real lifecycle. In the
 * funnel that path is crawl evidence → opportunity → task → outcome, and this
 * test asserts it end to end so deleting the legacy factory lost no guarantee.
 */

const AT = new Date("2026-11-03T00:00:00.000Z");

function mockDb(seed: Array<Record<string, unknown>>) {
  const opportunities = new Map<string, Record<string, unknown>>();
  const tasks: Array<Record<string, unknown>> = [];
  const outcomes: Array<Record<string, unknown>> = [];
  let counter = 0;
  const db = {
    evidenceRecord: {
      findMany: vi.fn(async (args?: { where?: { kind?: unknown } }) => {
        const kind = args?.where?.kind;
        if (!kind) return seed;
        const kinds = typeof kind === "string" ? [kind] : (kind as { in?: string[] }).in ?? [];
        return seed.filter((row) => kinds.includes(row.kind as string));
      }),
    },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue([]) },
    opportunity: {
      findMany: vi.fn(async (args?: { where?: { status?: string | { in?: string[] }; scoreValue?: { lt?: number } } }) => {
        return [...opportunities.values()]
          .filter((row) => {
            const status = args?.where?.status;
            if (!status) return true;
            if (typeof status === "string") return row.status === status;
            return status.in ? status.in.includes(row.status as string) : true;
          })
          .filter((row) => args?.where?.scoreValue?.lt == null || ((row.scoreValue as number) ?? 0) < args.where.scoreValue.lt);
      }),
      findUnique: vi.fn(async (args: { where: { id?: string; projectId_dedupKey?: { dedupKey: string } } }) => {
        if (args.where.id) return opportunities.get(args.where.id) ?? null;
        for (const row of opportunities.values()) if (row.dedupKey === args.where.projectId_dedupKey!.dedupKey) return row;
        return null;
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        counter += 1;
        const row = { id: `op-${counter}`, status: "detected", ...args.data };
        opportunities.set(row.id as string, row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = opportunities.get(args.where.id)!;
        Object.assign(row, args.data);
        return row;
      }),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(1) },
    task: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `task-${tasks.length + 1}`, status: "todo", ...args.data };
        tasks.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tasks.find((entry) => entry.id === args.where.id)!;
        Object.assign(row, args.data);
        return row;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => tasks.find((entry) => entry.id === args.where.id) ?? null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => tasks),
    },
    baseline: { findMany: vi.fn().mockResolvedValue([]) },
    outcomeObservation: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        outcomes.push(args.data);
        return { id: `out-${outcomes.length}` };
      }),
      findMany: vi.fn(async () => outcomes),
    },
  };
  return { db: db as never, opportunities, tasks, outcomes };
}

const crawlIssue = {
  id: "ev-crawl",
  kind: "onpage_crawl",
  observedAt: AT,
  producer: "crawler",
  dimensions: { url: "https://example.com/", issueType: "MISSING_SCHEMA", impact: "structured_data", schemaMissing: "true", schemaType: "LocalBusiness" },
  metrics: { "first_party:issueCount": { value: 1, unit: "count", source: "first_party" } },
};

describe("crawl gap → work lifecycle (ported from the retired action factory)", () => {
  it("turns a crawl gap into an opportunity, a task, a delivery and an outcome", async () => {
    const { db, opportunities, tasks } = mockDb([crawlIssue]);

    await runDetectors(db, "p1", { now: AT });
    expect(opportunities.size).toBe(1);
    const opportunity = [...opportunities.values()][0];
    expect(opportunity.type).toBe("O8_structured_data_gap");
    expect(opportunity.status).toBe("detected");

    // A task can only come from accepting the opportunity.
    const taskId = await acceptOpportunityIntoTask(db, opportunity.id as string, {
      title: String(opportunity.title),
      assignedTo: "dana",
    });
    expect(opportunities.get(opportunity.id as string)?.status).toBe("accepted");
    expect(tasks[0]).toMatchObject({ opportunityId: opportunity.id, status: "todo", assignedTo: "dana" });

    await confirmHumanStep(db, taskId, { status: "in_progress", confirmedBy: "dana" });
    await confirmHumanStep(db, taskId, { status: "delivered", confirmedBy: "dana" });
    expect(tasks[0].status).toBe("delivered");

    await recordDeliveryOutcome(db, {
      taskId,
      baseline: { metrics: { "first_party:issueCount": { value: 1, unit: "count" } }, observedAt: new Date("2026-11-03T00:00:00.000Z") },
      after: { metrics: { "first_party:issueCount": { value: 0, unit: "count" } }, observedAt: new Date("2026-11-10T00:00:00.000Z") },
      verdict: "verified_win",
      measuredBy: "recrawl",
    });
    expect(tasks[0].status).toBe("verified_outcome");
  });

  it("keeps the opportunity deduplicated across repeated crawls", async () => {
    const { db, opportunities } = mockDb([crawlIssue]);
    await runDetectors(db, "p1", { now: AT });
    await runDetectors(db, "p1", { now: AT });
    expect(opportunities.size).toBe(1);
  });
});
