import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  researchAction: { findMany: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
  emitConnectorEvent: vi.fn(),
  generateDraftForAction: vi.fn(),
  createAgentTaskForAction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mocks }));
vi.mock("@/lib/connectors/events", () => ({ emitConnectorEvent: mocks.emitConnectorEvent }));
vi.mock("@/lib/research/content", () => ({ generateDraftForAction: mocks.generateDraftForAction }));
vi.mock("@/lib/agent-tasks/service", () => ({ createAgentTaskForAction: mocks.createAgentTaskForAction }));

import { automateRunActions } from "@/lib/research/runner";

const action = (preparationStatus: string) => ({
  id: "action-1", projectId: "project-1", siteId: "site-1", revision: 4,
  status: "PROPOSED", automationMode: "MANUAL", preparationStatus, _count: { drafts: 0 }, agentTasks: [],
});

describe("HelloAda-owned Action automation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.researchAction.findMany.mockResolvedValue([action("NONE")]);
    mocks.researchAction.updateMany.mockResolvedValue({ count: 1 });
    mocks.$transaction.mockImplementation(async (callback) => callback({ researchAction: mocks.researchAction }));
  });

  it.each(["CANCELLED", "READY", "QUEUED", "BLOCKED"])("does not revive or re-emit a %s preparation", async (state) => {
    mocks.researchAction.findMany.mockResolvedValue([action(state)]);
    const result = await automateRunActions({ runId: "run-1", siteDomain: "example.com",
      autoDraft: true, autoAgent: true, connectorExecutor: "helloada" });

    expect(result.skipped).toContainEqual({ actionId: "action-1", reason: `preparation_already_${state.toLowerCase()}` });
    expect(mocks.researchAction.updateMany).not.toHaveBeenCalled();
    expect(mocks.emitConnectorEvent).not.toHaveBeenCalled();
    expect(mocks.generateDraftForAction).not.toHaveBeenCalled();
    expect(mocks.createAgentTaskForAction).not.toHaveBeenCalled();
  });

  it("claims eligibility once from NONE and emits one connector event", async () => {
    const result = await automateRunActions({ runId: "run-1", siteDomain: "example.com",
      autoDraft: true, autoAgent: true, connectorExecutor: "helloada" });

    expect(result).toMatchObject({ drafts: [], agentTasks: [], skipped: [] });
    expect(mocks.researchAction.updateMany).toHaveBeenCalledWith({
      where: { id: "action-1", revision: 4, preparationStatus: "NONE" },
      data: { preparationStatus: "ELIGIBLE" },
    });
    expect(mocks.emitConnectorEvent).toHaveBeenCalledTimes(1);
    expect(mocks.generateDraftForAction).not.toHaveBeenCalled();
    expect(mocks.createAgentTaskForAction).not.toHaveBeenCalled();
  });

  it("does not prepare HelloAda work through another executor's policy", async () => {
    const result = await automateRunActions({ runId: "run-1", siteDomain: "example.com",
      autoDraft: true, autoAgent: true, connectorExecutor: "wix" });

    expect(result.skipped).toContainEqual({ actionId: "action-1", reason: "site_has_another_active_executor" });
    expect(mocks.researchAction.updateMany).not.toHaveBeenCalled();
    expect(mocks.emitConnectorEvent).not.toHaveBeenCalled();
  });

  it("automatic policy marks preparation eligibility without creating a draft or task", async () => {
    mocks.researchAction.findMany.mockResolvedValue([{ ...action("NONE"), automationMode: "AUTOMATIC", projectId: null }]);
    const result = await automateRunActions({ runId: "run-1", siteDomain: "example.com",
      autoDraft: true, autoAgent: true, connectorExecutor: "crawlseo-agent" });
    expect(mocks.researchAction.updateMany).toHaveBeenCalledWith({
      where: { id: "action-1", revision: 4, status: "PROPOSED", preparationStatus: "NONE" },
      data: { preparationStatus: "ELIGIBLE" },
    });
    expect(mocks.generateDraftForAction).not.toHaveBeenCalled();
    expect(mocks.createAgentTaskForAction).not.toHaveBeenCalled();
    expect(result.skipped).toContainEqual({ actionId: "action-1", reason: "eligible_for_connector_preparation_owner_approval_required" });
  });
});
