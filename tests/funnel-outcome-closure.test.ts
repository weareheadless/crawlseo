import { describe, expect, it, vi } from "vitest";
import { recordDeliveryOutcome } from "@/lib/funnel/join";

function fixture(status = "delivered") {
  const task = { id: "t1", status, updatedAt: new Date("2026-11-03"), opportunityId: "op1" };
  const opportunity = { id: "op1", status: status === "verified_outcome" ? "closed" : "delivered" };
  const observations: unknown[] = [];
  const db = {
    task: {
      findUnique: vi.fn(async () => ({ ...task })),
      updateMany: vi.fn(async (args: { where: { status: string; updatedAt: Date }; data: { status: string } }) => {
        if (task.status !== args.where.status || task.updatedAt !== args.where.updatedAt) return { count: 0 };
        task.status = args.data.status;
        return { count: 1 };
      }),
    },
    opportunity: {
      updateMany: vi.fn(async (args: { where: { id: string; status: string | { in: string[] } }; data: { status: string } }) => {
        const allowed = typeof args.where.status === "string" ? opportunity.status === args.where.status : args.where.status.in.includes(opportunity.status);
        if (!allowed || args.where.id !== opportunity.id) return { count: 0 };
        opportunity.status = args.data.status;
        return { count: 1 };
      }),
    },
    outcomeObservation: { create: vi.fn(async (args: { data: unknown }) => { observations.push(args.data); return { id: `o${observations.length}` }; }) },
  };
  (db as unknown as { $transaction: (fn: (tx: typeof db) => unknown) => Promise<unknown> }).$transaction = async (fn) => fn(db);
  return { db, task, opportunity, observations };
}

const input = (verdict: "verified_win" | "no_effect" | "pending") => ({
  taskId: "t1", baseline: { metrics: {}, observedAt: new Date("2026-11-01") },
  after: { metrics: {}, observedAt: new Date("2026-11-10") }, verdict, measuredBy: "test",
});

describe("delivery outcome closure", () => {
  it("atomically verifies a winning task and closes its opportunity", async () => {
    const { db, task, opportunity } = fixture();
    await recordDeliveryOutcome(db as never, input("verified_win"));
    expect(task.status).toBe("verified_outcome");
    expect(opportunity.status).toBe("closed");
  });

  it("does not regress an already verified task for another measured verdict", async () => {
    const { db, task, opportunity } = fixture("verified_outcome");
    await recordDeliveryOutcome(db as never, input("no_effect"));
    expect(task.status).toBe("verified_outcome");
    expect(opportunity.status).toBe("closed");
  });

  it("rejects measurement before delivery and allows pending without progression", async () => {
    const early = fixture("todo");
    await expect(recordDeliveryOutcome(early.db as never, input("no_effect"))).rejects.toThrow(/requires a delivered task/);
    expect(early.observations).toHaveLength(0);
    await recordDeliveryOutcome(early.db as never, input("pending"));
    expect(early.task.status).toBe("todo");
    expect(early.observations).toHaveLength(1);
  });
});
