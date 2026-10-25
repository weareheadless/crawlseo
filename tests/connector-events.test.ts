import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findFirst: vi.fn() },
  connectorEvent: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { acknowledgeConnectorEvents, pollConnectorEvents, reportConnectorEventFailure } from "@/lib/connectors/service";

const principal = { credentialId: "credential-1", servicePrincipalId: "principal-1", workspaceId: "workspace-1", projectId: "project-1", scopes: ["connector:read", "connector:write"] };

describe("connector event delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1", project: { id: "project-1" }, connectorBinding: null });
  });

  it("returns all due unacknowledged deliveries after the consumer cursor has advanced", async () => {
    mockDb.connectorEvent.findMany.mockResolvedValue([{ id: "event-old", sequence: 2, attempts: 1 }]);
    await expect(pollConnectorEvents(principal, 20, 100, "site-1")).resolves.toEqual([{ id: "event-old", sequence: 2, attempts: 1 }]);
    expect(mockDb.connectorEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: "project-1", siteId: "site-1", acknowledgedAt: null, nextAttemptAt: expect.any(Object) }),
      orderBy: { sequence: "asc" },
    }));
  });

  it("uses compare-and-set for failure backoff so concurrent reports do not lose an attempt", async () => {
    mockDb.connectorEvent.findFirst.mockResolvedValue({ id: "event-1", attempts: 3 });
    mockDb.connectorEvent.updateMany.mockResolvedValue({ count: 1 });
    const response = await reportConnectorEventFailure(principal, "event-1", "Bearer secret-value", "site-1");
    expect(response).toMatchObject({ accepted: true });
    expect(mockDb.connectorEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "event-1", projectId: "project-1", siteId: "site-1", acknowledgedAt: null, attempts: 3 },
      data: expect.objectContaining({ attempts: 4, lastError: "Bearer [REDACTED]" }),
    }));
  });

  it("treats acknowledgements as exact project scoped receipt ids", async () => {
    mockDb.connectorEvent.updateMany.mockResolvedValue({ count: 1 });
    await expect(acknowledgeConnectorEvents(principal, ["event-1"], "site-1")).resolves.toMatchObject({ acknowledged: 1 });
    expect(mockDb.connectorEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: "project-1", siteId: "site-1", id: { in: ["event-1"] }, acknowledgedAt: null },
    }));
  });

  it("handles empty acknowledgements without issuing a broad update", async () => {
    await expect(acknowledgeConnectorEvents(principal, [], "site-1")).resolves.toMatchObject({ acknowledged: 0 });
    expect(mockDb.connectorEvent.updateMany).not.toHaveBeenCalled();
  });

  it("keeps event polling and acknowledgement within the requested project site", async () => {
    mockDb.site.findFirst.mockImplementation(async ({ where }) => ({ id: where.id, projectId: "project-1", project: { id: "project-1" } }));
    mockDb.connectorEvent.findMany.mockResolvedValue([]);
    mockDb.connectorEvent.updateMany.mockResolvedValue({ count: 0 });
    await pollConnectorEvents(principal, 0, 20, "site-2");
    expect(mockDb.connectorEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ siteId: "site-2" }),
    }));
    await acknowledgeConnectorEvents(principal, ["event-from-site-1"], "site-2");
    expect(mockDb.connectorEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ siteId: "site-2" }),
    }));
  });
});
