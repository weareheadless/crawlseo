import { describe, expect, it, vi } from "vitest";

import { syncOpportunityStatus } from "@/lib/funnel/join";

function fakeDb() {
  const calls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  return {
    calls,
    db: {
      task: { findUnique: vi.fn(async () => ({ opportunityId: "opp-1" })) },
      opportunity: {
        updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          calls.push(args);
          return { count: 1 };
        }),
      },
    },
  };
}

describe("the opportunity follows its task", () => {
  it("moves a delivered task's opportunity out of the to-do list", async () => {
    const { db, calls } = fakeDb();
    await syncOpportunityStatus(db as never, "task-1", "delivered");
    expect(calls[0].data).toEqual({ status: "delivered" });
    // Only rows that were still open are touched; parked and rejected stay put.
    expect(calls[0].where).toMatchObject({ id: "opp-1", status: { in: ["accepted", "in_progress"] } });
  });

  it("closes the opportunity when the outcome is verified", async () => {
    const { db, calls } = fakeDb();
    await syncOpportunityStatus(db as never, "task-1", "verified_outcome");
    expect(calls[0].data).toEqual({ status: "closed" });
  });

  it("records that work started, and leaves other states alone", async () => {
    const { db, calls } = fakeDb();
    await syncOpportunityStatus(db as never, "task-1", "in_progress");
    expect(calls[0].data).toEqual({ status: "in_progress" });
    await syncOpportunityStatus(db as never, "task-1", "awaiting_human");
    expect(calls).toHaveLength(1);
  });

  it("does nothing for a task with no opportunity", async () => {
    const { db, calls } = fakeDb();
    db.task.findUnique.mockResolvedValue({ opportunityId: null });
    await syncOpportunityStatus(db as never, "task-1", "delivered");
    expect(calls).toHaveLength(0);
  });
});
