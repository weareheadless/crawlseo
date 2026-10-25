import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  site: { findFirst: vi.fn() },
  connectorBindingTransfer: { findUnique: vi.fn(), create: vi.fn() },
  connectorBinding: { findUnique: vi.fn(), updateMany: vi.fn() },
  connectorExecutionState: { count: vi.fn() },
  connectorEvent: { count: vi.fn(), create: vi.fn() },
  researchBudgetReservation: { count: vi.fn() },
  connectorEventCounter: { upsert: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { ConnectorError, transferConnectorBinding } from "@/lib/connectors/service";

const principal = { credentialId: "cred", servicePrincipalId: "principal", workspaceId: "workspace", projectId: "project-1", scopes: ["connector:write"] };
const input = { siteId: "site-1", expectedGeneration: 3, expectedExecutor: "helloada" as const, nextExecutor: "crawlseo-agent" as const,
  idempotencyKey: "transfer-once", reason: "Approved handoff to the shared executor" };
const binding = { id: "binding-1", projectId: "project-1", siteId: "site-1", executor: "helloada", generation: 3, status: "ACTIVE" };

describe("operator connector binding transfer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mockDb.$queryRaw, site: mockDb.site, connectorBindingTransfer: mockDb.connectorBindingTransfer,
      connectorBinding: mockDb.connectorBinding, connectorExecutionState: mockDb.connectorExecutionState, connectorEvent: mockDb.connectorEvent,
      researchBudgetReservation: mockDb.researchBudgetReservation,
      connectorEventCounter: mockDb.connectorEventCounter,
    }));
    mockDb.connectorBindingTransfer.findUnique.mockResolvedValue(null);
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1" });
    mockDb.connectorBinding.findUnique.mockResolvedValue(binding);
    mockDb.connectorEvent.count.mockResolvedValue(0);
    mockDb.researchBudgetReservation.count.mockResolvedValue(0);
    mockDb.connectorExecutionState.count.mockResolvedValue(0);
    mockDb.connectorBinding.updateMany.mockResolvedValue({ count: 1 });
    mockDb.connectorBindingTransfer.create.mockImplementation(async ({ data }) => ({ id: "transfer-1", ...data }));
    mockDb.connectorEventCounter.upsert.mockResolvedValue({ sequence: 10 });
    mockDb.connectorEventCounter.update.mockResolvedValue({ sequence: 11 });
    mockDb.connectorEvent.create.mockResolvedValue({});
  });

  it("records a transfer only after draining outstanding deliveries and unresolved spend", async () => {
    await transferConnectorBinding(principal, input);
    expect(mockDb.$queryRaw).toHaveBeenCalled();
    expect(mockDb.connectorBinding.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ generation: 3, executor: "helloada" }),
      data: { executor: "crawlseo-agent", generation: { increment: 1 } },
    }));
    expect(mockDb.connectorBindingTransfer.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fromGeneration: 3, toGeneration: 4, reason: input.reason }),
    }));
  });

  it("rejects while an event is unacknowledged", async () => {
    mockDb.connectorEvent.count.mockResolvedValue(1);
    await expect(transferConnectorBinding(principal, input)).rejects.toBeInstanceOf(ConnectorError);
    expect(mockDb.connectorBinding.updateMany).not.toHaveBeenCalled();
  });

  it("rejects while an exact candidate awaits an owner decision", async () => {
    mockDb.connectorExecutionState.count.mockResolvedValue(1);
    await expect(transferConnectorBinding(principal, input)).rejects.toMatchObject({ status: 409 });
    expect(mockDb.connectorBinding.updateMany).not.toHaveBeenCalled();
  });

  it("does not activate Wix or Webflow until an execution adapter is implemented", async () => {
    await expect(transferConnectorBinding(principal, { ...input, nextExecutor: "webflow" }))
      .rejects.toMatchObject({ status: 409, message: "The webflow execution adapter is not implemented and cannot be activated" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("replays an exact idempotent transfer and rejects a changed request", async () => {
    mockDb.connectorBindingTransfer.findUnique.mockResolvedValue({ ...input, requestHash: "bad" });
    await expect(transferConnectorBinding(principal, input)).rejects.toMatchObject({ status: 409 });
    expect(mockDb.connectorBinding.findUnique).not.toHaveBeenCalled();
  });
});
