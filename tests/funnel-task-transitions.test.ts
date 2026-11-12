import { describe, expect, it, vi } from "vitest";
import { acceptOpportunityIntoTask, confirmHumanStep } from "@/lib/funnel/join";

function fixture(status = "in_progress", projectId = "project") {
  const task = { id: "task", opportunityId: "op", status, updatedAt: new Date("2026-11-01"),
    opportunity: { projectId, status: "in_progress" } };
  const tx = {
    task: { findUnique: vi.fn(async () => task), update: vi.fn(async ({ data }) => Object.assign(task, data)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.status !== task.status) return { count: 0 };
        Object.assign(task, data); return { count: 1 };
      }) },
    opportunity: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) };
  return { db, tx, task };
}

const input = { status: "delivered" as const, confirmedBy: "owner", expectedProjectId: "project", opportunityId: "op" };

describe("shared human task transition boundary", () => {
  it("cannot create another task by accepting active work again", async () => {
    const tx = { opportunity: { findUnique: vi.fn(async () => ({ id: "op", projectId: "project", status: "in_progress" })) },
      task: { create: vi.fn() } };
    const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
    await expect(acceptOpportunityIntoTask(db as never, "op", { title: "Task", assignedTo: "owner", expectedProjectId: "project" })).rejects.toThrow(/cannot be accepted/);
    expect(tx.task.create).not.toHaveBeenCalled();
  });
  it("rejects another project's task before a write", async () => {
    const { db, tx } = fixture("in_progress", "other-project");
    await expect(confirmHumanStep(db as never, "task", input)).rejects.toThrow(/belong|scope/);
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.task.update).not.toHaveBeenCalled();
  });

  it("rejects a mismatched opportunity before a write", async () => {
    const { db } = fixture();
    await expect(confirmHumanStep(db as never, "task", { ...input, opportunityId: "other" })).rejects.toThrow(/belong|scope/);
  });

  it.each([["todo", "verified_outcome"], ["verified_outcome", "in_progress"], ["delivered", "awaiting_human"]])(
    "rejects %s → %s", async (from, to) => {
      const { db } = fixture(from);
      await expect(confirmHumanStep(db as never, "task", { ...input, status: to as "delivered" })).rejects.toThrow(/transition/);
    });

  it("writes task confirmation and opportunity progression inside one transaction", async () => {
    const { db, tx, task } = fixture("delivered");
    await confirmHumanStep(db as never, "task", { ...input, status: "verified_outcome" });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(task.status).toBe("verified_outcome");
    expect(task).toMatchObject({ humanConfirmedBy: "owner" });
    expect(tx.opportunity.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "closed" } }));
  });

  it("rejects a concurrent status change rather than overwriting it", async () => {
    const { db, tx } = fixture();
    tx.task.updateMany.mockResolvedValue({ count: 0 });
    await expect(confirmHumanStep(db as never, "task", input)).rejects.toThrow(/changed/);
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
  });

  it("does not rewrite who confirmed an already applied transition", async () => {
    const { db, tx } = fixture("delivered");
    await confirmHumanStep(db as never, "task", input);
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.task.update).not.toHaveBeenCalled();
  });
});
