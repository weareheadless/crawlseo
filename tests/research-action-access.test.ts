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

/**
 * The workspace has one operator. Pages list every site and render every task,
 * so the API must answer for the same records; gating on `site.userId` made a
 * console that rendered fine poll its own task and get 404 forever.
 */
describe("workspace-wide access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("looks an Action up by id for any signed-in user", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({ id: "action-1" });
    await expect(userOwnsResearchAction("action-1", "user-1")).resolves.toBe(true);
    expect(mockDb.researchAction.findFirst).toHaveBeenCalledWith({
      where: { id: "action-1" },
      select: { id: true },
    });
  });

  it("still refuses an Action that does not exist", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue(null);
    await expect(userOwnsResearchAction("action-1", "user-2")).resolves.toBe(false);
  });

  it("does not serve a request without a session", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({ id: "action-1" });
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1" });
    await expect(userOwnsResearchAction("action-1", " ")).resolves.toBe(false);
    await expect(userOwnsSite("site-1", "")).resolves.toBe(false);
    expect(mockDb.researchAction.findFirst).not.toHaveBeenCalled();
    expect(mockDb.site.findFirst).not.toHaveBeenCalled();
  });

  it("scopes site-level Actions to the site, not the account", async () => {
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1" });
    await expect(userOwnsSite("site-1", "user-2")).resolves.toBe(true);
    expect(mockDb.site.findFirst).toHaveBeenCalledWith({
      where: { id: "site-1" },
      select: { id: true },
    });
  });

  it("resolves research runs, deliveries and agent tasks by id", async () => {
    mockDb.researchRun.findFirst.mockResolvedValue({ id: "run-1" });
    mockDb.delivery.findFirst.mockResolvedValue({ id: "delivery-1" });
    mockDb.agentTask.findFirst.mockResolvedValue({ id: "task-1" });
    await expect(userOwnsResearchRun("run-1", "user-2")).resolves.toBe(true);
    await expect(userOwnsDelivery("delivery-1", "user-2")).resolves.toBe(true);
    await expect(userOwnsAgentTask("task-1", "user-2")).resolves.toBe(true);
    expect(mockDb.researchRun.findFirst).toHaveBeenCalledWith({ where: { id: "run-1" }, select: { id: true } });
    expect(mockDb.delivery.findFirst).toHaveBeenCalledWith({ where: { id: "delivery-1" }, select: { id: true } });
    expect(mockDb.agentTask.findFirst).toHaveBeenCalledWith({ where: { id: "task-1" }, select: { id: true } });
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
      site: { id: "site-legacy", projectId: "project-1", domain: "oceanicvibes.com", userId: "user-1", connectorBinding: null },
    });
    mockDb.site.findMany.mockResolvedValue([
      { projectId: "project-1", domain: "oceanicvibes.com", connectorBinding: { status: "ACTIVE", executor: "helloada" },
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

  it("answers for an Action created under another account in the same workspace", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({
      site: { userId: "user-1", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
    });
    await expect(researchActionAccess("action-1", "user-2")).resolves.toBe("external");
  });
});
