import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({ db: {
  site: { findUnique: vi.fn() },
  researchAction: { findMany: vi.fn() },
  contentDraft: { findMany: vi.fn() },
  agentTask: { findMany: vi.fn() },
  researchRun: { findMany: vi.fn() },
  seoResearchRun: { findMany: vi.fn() },
} }));

vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/research/evidence", () => ({ sourceIdsForAction: vi.fn(() => []) }));

import { getWorkData } from "@/lib/work/service";

describe("canonical Work queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.site.findUnique.mockResolvedValue({ id: "site-a", domain: "example.test", projectId: null });
    db.researchAction.findMany.mockResolvedValue([{
      id: "action-1", siteId: "site-a", title: "Improve page",
      _count: { drafts: 3, agentTasks: 2, deliveries: 1 },
    }]);
    db.agentTask.findMany.mockResolvedValue([{ id: "orphan-task", siteId: "site-a", actionId: null, action: null }]);
    db.researchRun.findMany.mockResolvedValue([]);
  });

  it("returns each action once with all child versions/attempts counted on it", async () => {
    const work = await getWorkData("site-a");

    expect(work.actions).toHaveLength(1);
    expect(work.actions[0]._count).toEqual({ drafts: 3, agentTasks: 2, deliveries: 1 });
    expect(work.drafts).toEqual([]);
    expect(db.contentDraft.findMany).not.toHaveBeenCalled();
    expect(db.researchAction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: "site-a" } }));
  });

  it("keeps legacy standalone tasks explicitly parentless and site scoped", async () => {
    const work = await getWorkData("site-a");

    expect(work.agentTasks).toEqual([expect.objectContaining({ id: "orphan-task", actionId: null })]);
    expect(db.agentTask.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { siteId: "site-a", actionId: null },
    }));
  });

  it("rejects an unknown site instead of returning unscoped work", async () => {
    db.site.findUnique.mockResolvedValue(null);

    await expect(getWorkData("missing-site")).rejects.toMatchObject({ status: 404 });
  });
});
