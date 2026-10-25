import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findUnique: vi.fn() },
  researchAction: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  connectorExecutionState: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/connectors/events", () => ({ emitConnectorEvent: vi.fn() }));

import { createResearchAction } from "@/lib/research/service";

describe("research Action deduplication around owner execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.site.findUnique.mockResolvedValue({ id: "site-1", projectId: "project-1" });
    mockDb.researchAction.findUnique.mockResolvedValue(null);
    const conflict = {
      id: "action-1", siteId: "site-1", projectId: "project-1", revision: 3,
      status: "PROPOSED", preparationStatus: "READY", priority: 70,
      title: "Improve the ownership page", recommendation: "Add clear ownership guidance.",
      targetUrl: "https://example.com/ownership", kind: "update_page", primaryQuery: "ownership",
      evidence: { source_ids: ["source-old"] }, runId: "run-old", findingId: "finding-old",
    };
    mockDb.researchAction.findUnique.mockImplementation(async (query) =>
      query.where?.id ? conflict : null);
    mockDb.researchAction.findMany.mockResolvedValue([conflict]);
    mockDb.$transaction.mockImplementation(async (callback) => callback({
      researchAction: {
        findUnique: mockDb.researchAction.findUnique,
        update: mockDb.researchAction.update,
        create: mockDb.researchAction.create,
      },
      connectorExecutionState: mockDb.connectorExecutionState,
    }));
    mockDb.connectorExecutionState.findUnique.mockResolvedValue({ status: "preparation_ready", ownerDecision: null });
  });

  it("does not revise or replace an exact candidate while its owner review is open", async () => {
    const result = await createResearchAction("site-1", {
      source: "market_research", kind: "update_page", title: "Improve the ownership page",
      targetUrl: "https://example.com/ownership", primaryQuery: "foreign ownership",
      recommendation: "Add current guidance based on newly collected evidence.", priority: 80,
      automationMode: "MANUAL",
      evidence: { source_ids: ["source-new"] },
    }, "user-1");

    expect(result).toMatchObject({ action: { id: "action-1", revision: 3 }, created: false, merged: false });
    expect(mockDb.researchAction.update).not.toHaveBeenCalled();
  });

  it("merges fresh evidence for the same dedupe key once and keeps retries idempotent", async () => {
    let current = {
      id: "action-1", siteId: "site-1", projectId: "project-1", revision: 3,
      status: "APPROVED", preparationStatus: "NONE", preparationRequestId: "old-attempt", priority: 70,
      title: "Improve the ownership page", recommendation: "Add clear ownership guidance.",
      targetUrl: "https://example.com/ownership", kind: "update_page", primaryQuery: "ownership",
      evidence: { source_ids: ["source-old"], research_run_id: "run-1" }, runId: "run-old", findingId: "finding-old",
    };
    mockDb.researchAction.findUnique.mockImplementation(async () => current);
    mockDb.researchAction.findMany.mockResolvedValue([current]);
    mockDb.connectorExecutionState.findUnique.mockResolvedValue(null);
    mockDb.researchAction.update.mockImplementation(async ({ data }) => {
      current = { ...current, ...data, revision: current.revision + 1,
        preparationStatus: "NONE", evidence: data.evidence };
      return current;
    });
    const input = {
      source: "market_research", kind: "update_page", title: "Improve the ownership page",
      targetUrl: "https://example.com/ownership", primaryQuery: "ownership",
      recommendation: "Add current guidance based on newly collected evidence.", priority: 70,
      automationMode: "MANUAL" as const,
      evidence: { source_ids: ["source-old", "source-new"], source_refs: ["run-2"], research_run_id: "run-2" },
    };

    const first = await createResearchAction("site-1", input, "user-1");
    const retry = await createResearchAction("site-1", input, "user-1");

    expect(first).toMatchObject({ created: false, merged: true, action: { revision: 4, status: "PROPOSED" } });
    expect(retry).toMatchObject({ created: false, merged: false, action: { revision: 4 } });
    expect(current.recommendation).toBe(input.recommendation);
    expect(current.preparationRequestId).toBeNull();
    expect(current.evidence).toEqual({ source_ids: ["source-old", "source-new"], source_refs: ["run-2"],
      research_run_id: "run-2", research_run_ids: ["run-1", "run-2"] });
    expect(mockDb.researchAction.update).toHaveBeenCalledTimes(1);
  });

  it("recognizes reworded open work on the same target by its informative subject", async () => {
    let current = {
      id: "action-1", siteId: "site-1", projectId: "project-1", revision: 3,
      status: "PROPOSED", preparationStatus: "NONE", priority: 70,
      title: "Improve the ownership page", recommendation: "Explain how ownership works.",
      targetUrl: "https://example.com/ownership", kind: "update_page", primaryQuery: "ownership",
      evidence: { source_ids: ["source-old"] }, runId: "run-old", findingId: "finding-old",
    };
    mockDb.researchAction.findUnique.mockImplementation(async (query) => query.where?.id ? current : null);
    mockDb.researchAction.findMany.mockResolvedValue([current]);
    mockDb.connectorExecutionState.findUnique.mockResolvedValue(null);
    mockDb.researchAction.update.mockImplementation(async ({ data }) => {
      current = { ...current, ...data, revision: current.revision + 1 };
      return current;
    });

    const result = await createResearchAction("site-1", {
      source: "market_research", kind: "update_page", title: "Clarify ownership responsibilities for the page",
      targetUrl: "https://example.com/ownership", primaryQuery: "property governance",
      recommendation: "Clarify which ownership responsibilities the page should explain.", priority: 75,
      automationMode: "MANUAL", evidence: { source_ids: ["source-new"] },
    }, "user-1");

    expect(result).toMatchObject({ created: false, merged: true, action: { id: "action-1", revision: 4 } });
    expect(current.evidence).toMatchObject({ source_ids: ["source-old", "source-new"] });
  });

  it("does not merge unrelated work on the same page", async () => {
    const existing = {
      id: "action-1", siteId: "site-1", projectId: "project-1", revision: 3,
      status: "PROPOSED", preparationStatus: "NONE", priority: 70,
      title: "Improve the ownership page", recommendation: "Explain how ownership works.",
      targetUrl: "https://example.com/ownership", kind: "update_page", primaryQuery: "ownership",
      evidence: { source_ids: ["source-old"] }, runId: "run-old", findingId: "finding-old",
    };
    mockDb.researchAction.findUnique.mockResolvedValue(null);
    mockDb.researchAction.findMany.mockResolvedValue([existing]);
    mockDb.researchAction.create.mockResolvedValue({ id: "action-2", title: "Payment options",
      recommendation: "Explain available payment options.", status: "PROPOSED", revision: 1,
      priority: 60, targetUrl: existing.targetUrl, projectId: "project-1" });

    const result = await createResearchAction("site-1", {
      source: "market_research", kind: "update_page", title: "Explain payment options",
      targetUrl: "https://example.com/ownership", primaryQuery: "payment options",
      recommendation: "Explain the available payment options.", priority: 60,
      automationMode: "MANUAL", evidence: { source_ids: ["source-payment"] },
    }, "user-1");

    expect(result).toMatchObject({ created: true, action: { id: "action-2" } });
    expect(mockDb.researchAction.update).not.toHaveBeenCalled();
  });
});
