import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  site: { findFirst: vi.fn() },
  siteProfile: { upsert: vi.fn() },
  researchPolicy: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  seoResearchPolicy: { upsert: vi.fn() },
  connectorOperationReceipt: { findUnique: vi.fn(), create: vi.fn() },
  businessKnowledgeDocument: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { ConnectorError, updateConnectorResearchProfile } from "@/lib/connectors/service";

const principal = { credentialId: "cred", servicePrincipalId: "principal", workspaceId: "workspace", projectId: "project-1", scopes: ["connector:read", "connector:write"] };
const input = {
  siteId: "site-1",
  expectedRevision: 0,
  idempotencyKey: "site-agent:oceanic:research-profile:origin-1",
  profile: {
    topics: ["freediving safety", "cenote training"],
    audience: "Freedivers and ocean-curious people",
    market: "Mexico",
    language: "en",
    goals: ["Increase qualified freediving training enquiries"],
    exclusions: ["medical claims"],
  },
  researchPolicy: {
    enabled: true,
    cadence: "weekly" as const,
    providers: ["reddit", "news"] as Array<"reddit" | "news">,
    maxSources: 25,
    monthlyBudget: 6,
    recencyDays: 45,
    autoDraft: false,
    autoAgent: false,
  },
  seoResearch: {
    enabled: true,
    monthlyTaskLimit: 9,
    keywordSeedLimit: 5,
    competitorLimit: 1,
    packageVersion: "standard-v1",
    articleResearchEnabled: true,
    articleTaskLimitPerMonth: 5,
    articleMinIntervalDays: 7,
  },
};

describe("atomic research profile contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1", project: { id: "project-1" } });
    mockDb.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mockDb.$queryRaw,
      siteProfile: { ...mockDb.siteProfile, findUnique: vi.fn().mockResolvedValue({ constraints: { retainedPolicy: "keep" } }) },
      researchPolicy: mockDb.researchPolicy,
      seoResearchPolicy: mockDb.seoResearchPolicy,
      connectorOperationReceipt: mockDb.connectorOperationReceipt,
      businessKnowledgeDocument: mockDb.businessKnowledgeDocument,
    }));
    mockDb.connectorOperationReceipt.findUnique.mockResolvedValue(null);
    mockDb.connectorOperationReceipt.create.mockResolvedValue({});
    mockDb.businessKnowledgeDocument.findUnique.mockResolvedValue(null);
    mockDb.researchPolicy.findUnique.mockResolvedValue(null);
    mockDb.researchPolicy.create.mockImplementation(async ({ data }) => ({ ...data }));
    mockDb.researchPolicy.update.mockImplementation(async ({ data }) => ({ revision: 4, ...data }));
    mockDb.siteProfile.upsert.mockResolvedValue({});
    mockDb.seoResearchPolicy.upsert.mockResolvedValue({});
  });

  it("writes the profile, research policy and SEO research policy in one transaction", async () => {
    await expect(updateConnectorResearchProfile(principal, input)).resolves.toMatchObject({
      schemaVersion: "1.0", projectId: "project-1", siteId: "site-1", revision: 1,
      profile: { topics: ["freediving safety", "cenote training"] },
      seoResearch: { articleResearchEnabled: true, articleMinIntervalDays: 7 },
    });
    expect(mockDb.siteProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { siteId: "site-1" },
      create: expect.objectContaining({
        projectId: "project-1",
        language: "en",
        topics: ["freediving safety", "cenote training"],
        constraints: { retainedPolicy: "keep", market: "Mexico", goals: ["Increase qualified freediving training enquiries"], exclusions: ["medical claims"] },
      }),
    }));
    expect(mockDb.researchPolicy.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ siteId: "site-1", revision: 1, providers: ["reddit", "news"], monthlyBudget: 6 }),
    }));
    expect(mockDb.seoResearchPolicy.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { siteId: "site-1" },
      create: expect.objectContaining({ projectId: "project-1", monthlyTaskLimit: 9, articleMinIntervalDays: 7 }),
    }));
    expect(mockDb.connectorOperationReceipt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ operation: "research_profile", idempotencyKey: input.idempotencyKey }),
    }));
  });

  it("rejects a stale revision before writing anything", async () => {
    mockDb.researchPolicy.findUnique.mockResolvedValue({ revision: 3 });
    await expect(updateConnectorResearchProfile(principal, { ...input, expectedRevision: 2 })).rejects.toBeInstanceOf(ConnectorError);
    expect(mockDb.siteProfile.upsert).not.toHaveBeenCalled();
    expect(mockDb.researchPolicy.create).not.toHaveBeenCalled();
    expect(mockDb.seoResearchPolicy.upsert).not.toHaveBeenCalled();
  });

  it("replays the exact same content after the revision advances", async () => {
    const requestHash = createHash("sha256").update(JSON.stringify({
      siteId: input.siteId,
      profile: input.profile,
      researchPolicy: input.researchPolicy,
      seoResearch: input.seoResearch,
    })).digest("hex");
    mockDb.connectorOperationReceipt.findUnique.mockResolvedValue({ requestHash, result: { revision: 1, replayed: true } });
    await expect(updateConnectorResearchProfile(principal, { ...input, expectedRevision: 1 })).resolves.toEqual({ revision: 1, replayed: true });
    expect(mockDb.siteProfile.upsert).not.toHaveBeenCalled();
    expect(mockDb.researchPolicy.create).not.toHaveBeenCalled();
    expect(mockDb.seoResearchPolicy.upsert).not.toHaveBeenCalled();
  });

  it("rejects an idempotency key reused with a different payload", async () => {
    mockDb.connectorOperationReceipt.findUnique.mockResolvedValue({ requestHash: "different", result: { revision: 1 } });
    await expect(updateConnectorResearchProfile(principal, input)).rejects.toThrow("different research profile");
  });

  it("keeps research targeting editable alongside canonical business facts", async () => {
    mockDb.businessKnowledgeDocument.findUnique.mockResolvedValue({ id: "doc-1" });
    await expect(updateConnectorResearchProfile(principal, input)).resolves.toMatchObject({ profile: input.profile });
    expect(mockDb.siteProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ topics: input.profile.topics, audience: input.profile.audience }),
      update: expect.objectContaining({ topics: input.profile.topics, audience: input.profile.audience }),
    }));
    expect(mockDb.businessKnowledgeDocument.findUnique).not.toHaveBeenCalled();
  });
});
