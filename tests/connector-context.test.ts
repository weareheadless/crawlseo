import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  site: { findFirst: vi.fn() },
  connectorContextSnapshot: { findUnique: vi.fn(), upsert: vi.fn() },
  researchAction: { count: vi.fn() },
  connectorExecutionState: { count: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  emitConnectorEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mocks }));
vi.mock("@/lib/connectors/events", () => ({ emitConnectorEvent: mocks.emitConnectorEvent }));

import { saveContextSnapshot } from "@/lib/connectors/service";

const principal = { credentialId: "credential-1", servicePrincipalId: "principal-1", workspaceId: "workspace-1",
  projectId: "project-1", scopes: ["connector:write"] };
const observedAt = new Date(Date.now() - 60_000).toISOString();
const input = { siteId: "site-1", revision: "inventory-2", expectedRevision: "inventory-1",
  canonicalOrigin: "https://example.com/", observedAt,
  websiteInventory: [{ url: "https://example.com/" }], businessFacts: { locale: "en" }, capabilities: { reviewOrigin: "https://helloada.example" } };

describe("connector context snapshot compare-and-set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.site.findFirst.mockResolvedValue({ id: "site-1", domain: "example.com", projectId: "project-1", project: { id: "project-1" } });
    mocks.$queryRaw.mockResolvedValue([]);
    mocks.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.$queryRaw,
      connectorContextSnapshot: mocks.connectorContextSnapshot,
      researchAction: mocks.researchAction,
      connectorExecutionState: mocks.connectorExecutionState,
    }));
  });

  it("checks the expected revision after locking the site and refuses stale concurrent writers", async () => {
    mocks.connectorContextSnapshot.findUnique.mockResolvedValue({ revision: "inventory-2" });

    await expect(saveContextSnapshot(principal, input)).rejects.toMatchObject({
      status: 409, message: "Context revision changed; refresh before retrying",
    });

    expect(mocks.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.connectorContextSnapshot.findUnique).toHaveBeenCalledWith({ where: { siteId: "site-1" } });
    expect(mocks.connectorContextSnapshot.upsert).not.toHaveBeenCalled();
    expect(mocks.emitConnectorEvent).not.toHaveBeenCalled();
  });

  it("emits the update only after a successful compare-and-set", async () => {
    mocks.connectorContextSnapshot.findUnique.mockResolvedValue({ revision: "inventory-1" });
    const snapshot = { revision: "inventory-2", observedAt: new Date(input.observedAt) };
    mocks.connectorContextSnapshot.upsert.mockResolvedValue(snapshot);

    await expect(saveContextSnapshot(principal, input)).resolves.toBe(snapshot);

    expect(mocks.connectorContextSnapshot.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { siteId: "site-1" },
      create: expect.objectContaining({ projectId: "project-1", siteId: "site-1", revision: "inventory-2" }),
    }));
    expect(mocks.emitConnectorEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      projectId: "project-1", siteId: "site-1", type: "context.updated",
      payload: { revision: "inventory-2", observedAt: input.observedAt },
    }));
  });

  it("refuses to change the owner review origin while a candidate awaits review", async () => {
    mocks.connectorContextSnapshot.findUnique.mockResolvedValue({ revision: "inventory-1",
      capabilities: { reviewOrigin: "https://helloada.example" }, observedAt: new Date(input.observedAt),
      canonicalOrigin: "https://example.com/", websiteInventory: input.websiteInventory,
      businessFacts: input.businessFacts });
    mocks.researchAction.count.mockResolvedValue(1);
    const changed = { ...input, capabilities: { reviewOrigin: "https://new-helloada.example" } };

    await expect(saveContextSnapshot(principal, changed)).rejects.toMatchObject({
      status: 409, message: "Owner review workspace cannot change while preparation or approval is active",
    });
    expect(mocks.connectorExecutionState.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ siteId: "site-1", status: { in: ["preparation_ready", "owner_decision"] } }),
    }));
    expect(mocks.connectorContextSnapshot.upsert).not.toHaveBeenCalled();
  });

  it("rejects a review URL where the contract expects a bare origin", async () => {
    await expect(saveContextSnapshot(principal, { ...input,
      capabilities: { reviewOrigin: "https://helloada.example/admin" },
    })).rejects.toMatchObject({ status: 400, message: "reviewOrigin must be a bare HTTP(S) origin without credentials or path" });
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });
});
