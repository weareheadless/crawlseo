import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  site: { findFirst: vi.fn() },
  siteProfile: { findUnique: vi.fn(), upsert: vi.fn() },
  researchPolicy: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { assertRequiredCapabilities, ConnectorError, getConnectorResearchPolicy, updateConnectorResearchPolicy } from "@/lib/connectors/service";

const principal = { credentialId: "cred", servicePrincipalId: "principal", workspaceId: "workspace", projectId: "project-1", scopes: ["connector:read", "connector:write"] };
const input = { siteId: "site-1", expectedRevision: 0, topics: ["topic"], goals: ["increase qualified leads"], exclusions: ["medical claims"], recencyDays: 45, audience: "buyers", market: "Mexico", language: "en",
  providers: ["reddit", "news"] as Array<"reddit" | "news">, cadence: "weekly" as const, enabled: true, maxSources: 25, monthlyBudget: 6,
  autoDraft: false, autoAgent: false };

describe("project-scoped research policy contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1", project: { id: "project-1" } });
    mockDb.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mockDb.$queryRaw, siteProfile: mockDb.siteProfile, researchPolicy: mockDb.researchPolicy,
    }));
    mockDb.siteProfile.findUnique.mockResolvedValue(null);
    mockDb.siteProfile.upsert.mockResolvedValue({});
    mockDb.researchPolicy.findUnique.mockResolvedValue(null);
    mockDb.researchPolicy.create.mockImplementation(async ({ data }) => ({ ...data }));
    mockDb.researchPolicy.update.mockImplementation(async ({ data }) => ({ revision: 4, ...data }));
  });

  it("rejects preparation when a declared Action capability is not supported by its executor", () => {
    expect(() => assertRequiredCapabilities(["content.prepare", "source.prepare"], ["content.prepare"]))
      .toThrow("Executor does not support required Action capabilities: source.prepare");
    expect(() => assertRequiredCapabilities(["content.prepare"], ["content.prepare", "source.prepare"]))
      .not.toThrow();
  });

  it("returns an explicit, versioned policy view with defaults", async () => {
    await expect(getConnectorResearchPolicy(principal, "site-1")).resolves.toMatchObject({
      schemaVersion: "1.0", projectId: "project-1", siteId: "site-1", revision: 0, goals: [], exclusions: [], recencyDays: 90,
      providers: ["reddit", "news", "web"], cadence: "weekly", maxSources: 30, monthlyBudget: 9,
    });
  });

  it("writes profile and research controls under one compare-and-swap transaction", async () => {
    await expect(updateConnectorResearchPolicy(principal, input)).resolves.toMatchObject({
      revision: 1, audience: "buyers", market: "Mexico", providers: ["reddit", "news"], monthlyBudget: 6,
      goals: ["increase qualified leads"], exclusions: ["medical claims"], recencyDays: 45,
    });
    expect(mockDb.$queryRaw).toHaveBeenCalled();
    expect(mockDb.siteProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { siteId: "site-1" }, create: expect.objectContaining({ projectId: "project-1",
        constraints: { market: "Mexico", goals: ["increase qualified leads"], exclusions: ["medical claims"] } }),
    }));
    expect(mockDb.researchPolicy.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ siteId: "site-1", revision: 1, monthlyBudget: 6 }),
    }));
  });

  it("rejects a stale policy revision before writing either record", async () => {
    mockDb.researchPolicy.findUnique.mockResolvedValue({ revision: 3 });
    await expect(updateConnectorResearchPolicy(principal, { ...input, expectedRevision: 2 })).rejects.toBeInstanceOf(ConnectorError);
    expect(mockDb.siteProfile.upsert).not.toHaveBeenCalled();
    expect(mockDb.researchPolicy.update).not.toHaveBeenCalled();
  });
});
