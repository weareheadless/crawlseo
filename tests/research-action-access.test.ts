import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  researchAction: { findFirst: vi.fn() },
  site: { findFirst: vi.fn(), findMany: vi.fn() },
  researchRun: { findFirst: vi.fn() },
  delivery: { findFirst: vi.fn() },
  agentTask: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { researchActionAccess, userOwnsAgentTask, userOwnsDelivery, userOwnsResearchAction, userOwnsResearchRun, userOwnsSite } from "@/lib/auth/research-action-access";

describe("research Action cookie ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes an Action lookup by both its id and the owning user", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({ id: "action-1" });
    await expect(userOwnsResearchAction("action-1", "user-1")).resolves.toBe(true);
    expect(mockDb.researchAction.findFirst).toHaveBeenCalledWith({
      where: { id: "action-1", OR: [{ site: { userId: "user-1" } }, { site: { userId: null } }] },
      select: { id: true },
    });
  });

  it("does not expose an Action when it is missing or owned by another user", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue(null);
    await expect(userOwnsResearchAction("action-1", "user-2")).resolves.toBe(false);
  });

  it("scopes site-level Action listing and creation by owner", async () => {
    mockDb.site.findFirst.mockResolvedValue(null);
    await expect(userOwnsSite("site-1", "user-2")).resolves.toBe(false);
    expect(mockDb.site.findFirst).toHaveBeenCalledWith({
      where: { id: "site-1", OR: [{ userId: "user-2" }, { userId: null }] },
      select: { id: true },
    });
  });

  it("scopes research runs and delivery measurements through their owning site", async () => {
    mockDb.researchRun.findFirst.mockResolvedValue(null);
    mockDb.delivery.findFirst.mockResolvedValue(null);
    await expect(userOwnsResearchRun("run-1", "user-2")).resolves.toBe(false);
    await expect(userOwnsDelivery("delivery-1", "user-2")).resolves.toBe(false);
    expect(mockDb.researchRun.findFirst).toHaveBeenCalledWith({
      where: { id: "run-1", OR: [{ site: { userId: "user-2" } }, { site: { userId: null } }] }, select: { id: true },
    });
    expect(mockDb.delivery.findFirst).toHaveBeenCalledWith({
      where: { id: "delivery-1", OR: [{ action: { site: { userId: "user-2" } } }, { action: { site: { userId: null } } }] }, select: { id: true },
    });
  });

  it("scopes agent tasks through their owning site", async () => {
    mockDb.agentTask.findFirst.mockResolvedValue(null);
    await expect(userOwnsAgentTask("task-1", "user-2")).resolves.toBe(false);
    expect(mockDb.agentTask.findFirst).toHaveBeenCalledWith({
      where: { id: "task-1", OR: [{ site: { userId: "user-2" } }, { site: { userId: null } }] }, select: { id: true },
    });
  });

  it("reports an owner-visible Action on an externally managed site as external", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({
      site: { userId: "user-1", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
    });
    await expect(researchActionAccess("action-1", "user-1")).resolves.toBe("external");
  });

  it("keeps Actions on a locally executed site mutable", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({
      site: { userId: "user-1", connectorBinding: { status: "ACTIVE", executor: "crawlseo-agent" } },
    });
    await expect(researchActionAccess("action-1", "user-1")).resolves.toBe("owner");
  });

  it("treats an Action on an unbound duplicate site as external when a bound sibling owns the domain", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({
      site: { id: "site-legacy", projectId: null, domain: "oceanicvibes.com", userId: "user-1", connectorBinding: null },
    });
    mockDb.site.findMany.mockResolvedValue([
      { projectId: null, domain: "oceanicvibes.com", connectorBinding: { status: "ACTIVE", executor: "helloada" },
        connectorContext: { capabilities: {} } },
    ]);
    await expect(researchActionAccess("action-1", "user-1")).resolves.toBe("external");
  });

  it("lets the signed-in operator work on a project-owned Action", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({
      site: { userId: null, connectorBinding: null },
    });
    await expect(researchActionAccess("action-1", "user-1")).resolves.toBe("owner");
  });

  it("does not reveal an external Action to a different user", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({
      site: { userId: "user-1", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
    });
    await expect(researchActionAccess("action-1", "user-2")).resolves.toBe("missing");
  });
});
