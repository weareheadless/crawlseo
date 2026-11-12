import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  site: vi.fn(), transaction: vi.fn(),
  db: { opportunity: { findMany: vi.fn(), findFirst: vi.fn() }, task: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: { ...mocks.db, $transaction: mocks.transaction } }));
vi.mock("@/lib/connectors/service", () => ({
  requireConnectorSite: mocks.site,
  ConnectorError: class extends Error { constructor(message: string, readonly status = 400) { super(message); } },
}));

import { confirmConnectorTask, listConnectorOpportunities, operateOnOpportunity } from "@/lib/connectors/opportunities";
const principal = { credentialId: "credential", servicePrincipalId: "relay", workspaceId: "workspace", projectId: "project", scopes: ["connector:write"] };
const at = new Date("2026-11-01T00:00:00.000Z");
const confirmation = { siteId: "site", generation: 2, idempotencyKey: "request", confirmedBy: "owner-1", confirmationRef: "conversation:1/message:2" };

describe("Opportunity/Task connector", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.site.mockResolvedValue({ id: "site", connectorBinding: { status: "ACTIVE", executor: "helloada", generation: 2 } });
  });

  it("reads current Opportunities, not legacy ResearchActions, with explicit pagination", async () => {
    mocks.db.opportunity.findMany.mockResolvedValue([{ id: "one" }, { id: "two" }]);
    const result = await listConnectorOpportunities(principal, { siteId: "site", limit: 1 });
    expect(result.opportunities).toEqual([{ id: "one" }]);
    expect(result.nextCursor).toBe("one");
    expect(mocks.db.opportunity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: "project" }, take: 2 }));
  });

  it("rejects cross-project pagination cursors", async () => {
    mocks.db.opportunity.findFirst.mockResolvedValue(null);
    await expect(listConnectorOpportunities(principal, { siteId: "site", limit: 10, cursor: "other" })).rejects.toMatchObject({ status: 400 });
    expect(mocks.db.opportunity.findMany).not.toHaveBeenCalled();
  });

  function transaction() {
    const task = { id: "task", opportunityId: "op", status: "delivered", updatedAt: at,
      opportunity: { projectId: "project", status: "delivered" } };
    const tx = {
      $queryRaw: vi.fn(), connectorBinding: { findUnique: vi.fn(async () => ({ status: "ACTIVE", executor: "helloada", generation: 2 })) },
      connectorOperationReceipt: { findUnique: vi.fn(async () => null), create: vi.fn() },
      task: { findFirst: vi.fn(async () => task), findUnique: vi.fn(async () => task),
        updateMany: vi.fn(async () => ({ count: 1 })) },
      opportunity: { findFirst: vi.fn(async () => ({ id: "op", projectId: "project", status: "detected", updatedAt: at })),
        updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    mocks.transaction.mockImplementation(async (fn) => fn(tx));
    return tx;
  }

  it("records human confirmation separately from its relay and closes the opportunity atomically", async () => {
    const tx = transaction();
    await confirmConnectorTask(principal, "task", { ...confirmation, opportunityId: "op", status: "verified_outcome", expectedStatus: "delivered" });
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ humanConfirmedBy: "owner-1" }) }));
    expect(tx.$queryRaw).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('FROM "ConnectorBinding"')]), "site");
    expect(tx.opportunity.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "closed" } }));
    expect(tx.connectorOperationReceipt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      result: expect.objectContaining({ confirmation: { ownerId: "owner-1", reference: confirmation.confirmationRef, relayedBy: "relay" } }),
    }) }));
  });

  it("replays a durable receipt without repeating the transition", async () => {
    const tx = transaction();
    let receipt: unknown;
    tx.connectorOperationReceipt.create.mockImplementation(async ({ data }) => { receipt = data; });
    const input = { ...confirmation, opportunityId: "op", status: "verified_outcome" as const, expectedStatus: "delivered" as const };
    const first = await confirmConnectorTask(principal, "task", input);
    tx.connectorOperationReceipt.findUnique.mockImplementation(async () => receipt as never);
    tx.connectorBinding.findUnique.mockResolvedValue({ status: "ACTIVE", executor: "helloada", generation: 3 });
    expect(await confirmConnectorTask(principal, "task", input)).toEqual(first);
    expect(tx.task.updateMany).toHaveBeenCalledOnce();
    await expect(confirmConnectorTask(principal, "task", { ...input, confirmedBy: "different-owner" })).rejects.toMatchObject({ status: 409 });
  });

  it("fences a transferred executor generation before writing", async () => {
    const tx = transaction();
    tx.connectorBinding.findUnique.mockResolvedValue({ status: "ACTIVE", executor: "helloada", generation: 3 });
    await expect(confirmConnectorTask(principal, "task", { ...confirmation, opportunityId: "op", status: "verified_outcome", expectedStatus: "delivered" })).rejects.toMatchObject({ status: 409 });
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("does not accept or reject an opportunity from another project", async () => {
    const tx = transaction();
    tx.opportunity.findFirst.mockResolvedValue(null as never);
    await expect(operateOnOpportunity(principal, "other-op", { ...confirmation, operation: "reject", expectedUpdatedAt: at.toISOString() })).rejects.toMatchObject({ status: 404 });
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
  });

  it("only the acceptance gate creates a task, and a request replay reuses that task", async () => {
    const tx = transaction();
    const opportunity = { id: "op", projectId: "project", status: "detected", updatedAt: at, title: "Improve the page" };
    Object.assign(tx.opportunity, { findUnique: vi.fn(async () => opportunity) });
    const create = vi.fn(async () => ({ id: "new-task" }));
    Object.assign(tx.task, { create });
    let receipt: unknown;
    tx.connectorOperationReceipt.create.mockImplementation(async ({ data }) => { receipt = data; });
    const input = { ...confirmation, operation: "accept" as const, expectedUpdatedAt: at.toISOString() };
    const first = await operateOnOpportunity(principal, "op", input);
    expect(first).toMatchObject({ taskId: "new-task", status: "accepted" });
    tx.connectorOperationReceipt.findUnique.mockImplementation(async () => receipt as never);
    expect(await operateOnOpportunity(principal, "op", input)).toEqual(first);
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects a stale opportunity review and a task/opportunity mismatch", async () => {
    const tx = transaction();
    await expect(operateOnOpportunity(principal, "op", { ...confirmation, operation: "park", expectedUpdatedAt: "2026-10-01T00:00:00.000Z" })).rejects.toMatchObject({ status: 409 });
    await expect(confirmConnectorTask(principal, "task", { ...confirmation, opportunityId: "other-op", status: "verified_outcome", expectedStatus: "delivered" })).rejects.toMatchObject({ status: 404 });
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
  });

  it("rejects reusing an opportunity decision key to change park into acceptance", async () => {
    const tx = transaction();
    let receipt: unknown;
    tx.connectorOperationReceipt.create.mockImplementation(async ({ data }) => { receipt = data; });
    const input = { ...confirmation, operation: "park" as const, expectedUpdatedAt: at.toISOString() };
    await operateOnOpportunity(principal, "op", input);
    tx.connectorOperationReceipt.findUnique.mockImplementation(async () => receipt as never);
    await expect(operateOnOpportunity(principal, "op", { ...input, operation: "accept" })).rejects.toMatchObject({ status: 409 });
    expect(tx.opportunity.updateMany).toHaveBeenCalledOnce();
    expect(tx.connectorOperationReceipt.create).toHaveBeenCalledOnce();
  });
});
