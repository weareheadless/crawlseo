import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    seoResearchTask: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    seoResearchRun: { update: vi.fn() },
  },
  connectorBudget: vi.fn(), reserveConnectorBudget: vi.fn(), settleConnectorBudget: vi.fn(),
  executeDataForSeoOperation: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/connectors/service", () => ({
  ConnectorError: class ConnectorError extends Error { constructor(message: string, readonly status = 409) { super(message); } },
  connectorBudget: mocks.connectorBudget,
  reserveConnectorBudget: mocks.reserveConnectorBudget,
  settleConnectorBudget: mocks.settleConnectorBudget,
}));
vi.mock("@/lib/dataforseo/client", () => ({
  executeDataForSeoOperation: mocks.executeDataForSeoOperation,
  resolveDataForSeoLocale: vi.fn(),
}));
vi.mock("@/lib/seo-metrics", () => ({ getTopKeywords: vi.fn(), getTopPages: vi.fn(), getSitePeriodMetrics: vi.fn(), seoMetricsDateRange: vi.fn() }));
vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: vi.fn() }));

import { executeReservedTask } from "@/lib/dataforseo/research";

describe("paid SEO task reservation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.seoResearchTask.findUnique.mockResolvedValue({ id: "task-1", kind: "KEYWORD_SEED", input: {
      seed: "tulum property", language_code: "en", location_code: 2840,
    }, researchRunId: "run-1" });
    mocks.db.seoResearchTask.updateMany.mockResolvedValue({ count: 1 });
    mocks.db.seoResearchTask.update.mockResolvedValue({});
    mocks.db.seoResearchRun.update.mockResolvedValue({});
    mocks.connectorBudget.mockResolvedValue({ configured: true, period: "2026-10", policyRevision: 7,
      currency: "USD", maxOperationMicros: "50000" });
    mocks.reserveConnectorBudget.mockResolvedValue({ id: "reservation-1", status: "RESERVED" });
    mocks.settleConnectorBudget.mockResolvedValue({ id: "reservation-1" });
    mocks.executeDataForSeoOperation.mockResolvedValue({ providerTaskId: "provider-1", costMicros: 17000, result: { rows: [] } });
  });

  it("reserves the owner ceiling before claiming and dispatching the paid task", async () => {
    await executeReservedTask("task-1", "project-1", "site-1");
    expect(mocks.reserveConnectorBudget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      idempotencyKey: "dataforseo-task:task-1", amountMicros: "50000", operation: "dataforseo:keyword_seed",
    }));
    expect(mocks.reserveConnectorBudget.mock.invocationCallOrder[0]).toBeLessThan(mocks.db.seoResearchTask.updateMany.mock.invocationCallOrder[0]);
    expect(mocks.executeDataForSeoOperation).toHaveBeenCalledTimes(1);
    expect(mocks.settleConnectorBudget).toHaveBeenCalledWith(expect.any(Object), "reservation-1", expect.objectContaining({
      status: "settled", actualCostMicros: "17000", providerTaskId: "provider-1",
    }));
  });

  it("does not claim or dispatch when the per-operation ceiling is absent", async () => {
    mocks.connectorBudget.mockResolvedValue({ configured: true, period: "2026-10", policyRevision: 7,
      currency: "USD", maxOperationMicros: null });
    await expect(executeReservedTask("task-1", "project-1", "site-1")).rejects.toThrow(/per-operation ceiling/);
    expect(mocks.reserveConnectorBudget).not.toHaveBeenCalled();
    expect(mocks.db.seoResearchTask.updateMany).not.toHaveBeenCalled();
    expect(mocks.executeDataForSeoOperation).not.toHaveBeenCalled();
  });

  it("does not compare USD provider costs against another policy currency", async () => {
    mocks.connectorBudget.mockResolvedValue({ configured: true, period: "2026-10", policyRevision: 7,
      currency: "MXN", maxOperationMicros: "50000" });
    await expect(executeReservedTask("task-1", "project-1", "site-1")).rejects.toThrow(/USD budget policy/);
    expect(mocks.reserveConnectorBudget).not.toHaveBeenCalled();
    expect(mocks.executeDataForSeoOperation).not.toHaveBeenCalled();
  });

  it("holds uncertain provider dispatches without retrying or releasing their reservation", async () => {
    mocks.executeDataForSeoOperation.mockRejectedValue(new Error("network timeout after dispatch"));
    await executeReservedTask("task-1", "project-1", "site-1");
    expect(mocks.settleConnectorBudget).toHaveBeenCalledWith(expect.any(Object), "reservation-1", expect.objectContaining({ status: "uncertain" }));
    expect(mocks.db.seoResearchTask.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "UNCERTAIN" }),
    }));
  });
});
