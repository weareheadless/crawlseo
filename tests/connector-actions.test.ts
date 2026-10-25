import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findFirst: vi.fn() },
  researchAction: { findFirst: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  researchSource: { findMany: vi.fn() },
  connectorContextSnapshot: { findFirst: vi.fn() },
  researchPolicy: { findUnique: vi.fn() },
  project: { findUnique: vi.fn() },
  connectorExecutionState: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { connectorCapabilities, ConnectorError, getConnectorAction, listConnectorActions } from "@/lib/connectors/service";

const principal = { credentialId: "cred", servicePrincipalId: "principal", workspaceId: "workspace", projectId: "project-1", scopes: ["connector:read"] };
const action = { id: "action-1", projectId: "project-1", siteId: "site-1", revision: 2, title: "Fix page",
  recommendation: "Update the page using the cited research.", priority: 50, priorityRationale: "High opportunity",
  targetUrl: "https://example.com/page", evidence: { source_ids: ["source-1", "missing-source"] },
  preparationStatus: "NONE", requiredCapabilities: ["content.prepare"], acceptanceCriteria: [], dependencies: [],
  reassessmentConditions: [], site: { id: "site-1", domain: "example.com" },
  finding: { summary: "The page lacks useful detail.", evidenceSourceIds: ["source-1", "missing-source"] } };

describe("connector Action envelope and pagination scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1", project: { id: "project-1" }, connectorBinding: { executor: "helloada" } });
    mockDb.researchAction.findFirst.mockResolvedValue(action);
    mockDb.researchSource.findMany.mockResolvedValue([{ id: "source-1", provider: "news", url: "https://news.example/story",
      title: "Story", publishedAt: null, retrievedAt: new Date("2026-10-25T11:00:00Z"), language: "en", metadata: {},
      run: { brief: { market: "MX", language: "en" }, recencyDays: 30, policyRevision: 4 } }]);
    mockDb.connectorContextSnapshot.findFirst.mockResolvedValue({ revision: "ctx-3" });
    mockDb.researchPolicy.findUnique.mockResolvedValue({ revision: 5, recencyDays: 14 });
    mockDb.project.findUnique.mockResolvedValue({ externalProjectId: "external-1" });
    mockDb.connectorExecutionState.findUnique.mockResolvedValue(null);
  });

  it("returns incomplete evidence explicitly so consumers can keep the Action out of owner work", async () => {
    const result = await getConnectorAction(principal, "action-1");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidenceComplete).toBe(false);
    expect(result.unavailableEvidenceSourceIds).toEqual(["missing-source"]);
    expect(result.evidence[0].recencyLimitDays).toBe(14);
    expect(result.evidence[0].researchPolicyRevision).toBe(4);
    expect(result.evidence[0].currentPolicyRevision).toBe(5);
    expect(result.contextRevisions.researchPolicy).toEqual([4]);
    expect(result.contextRevisions.currentResearchPolicy).toBe(5);
  });

  it("does not label an ungrounded Action as evidence complete", async () => {
    mockDb.researchAction.findFirst.mockResolvedValue({ ...action, evidence: {}, finding: null });
    mockDb.researchSource.findMany.mockResolvedValue([]);
    const result = await getConnectorAction(principal, "action-1");
    expect(result.evidence).toEqual([]);
    expect(result.evidenceComplete).toBe(false);
  });

  it("advertises implemented web RSS truthfully and keeps competitor research unsupported", async () => {
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1",
      project: { id: "project-1", externalProjectId: "external-1", workspaceId: "workspace" },
      connectorBinding: { executor: "helloada", generation: 2, status: "ACTIVE" } });
    const result = await connectorCapabilities(principal, "site-1");
    expect(result.capabilities).toContain("findings.read");
    expect(result.capabilities).toContain("providers.web-news-rss");
    expect(result.researchProviders).toContainEqual({ id: "web", implementation: "web_news_rss", billable: false,
      limitations: ["RSS search results only; does not fetch or crawl full web pages"] });
    expect(result.researchProviders).toContainEqual({ id: "competitor", supported: false,
      reason: "Competitor research requires a domain-specific, budget-reserved provider operation" });
  });

  it("rejects malformed since timestamps and cross-project cursor reuse", async () => {
    await expect(listConnectorActions(principal, { siteId: "site-1", since: "not-a-time", limit: 10 })).rejects.toMatchObject({
      message: "Action since timestamp is invalid",
    });
    const cursor = Buffer.from(JSON.stringify({ projectId: "other-project", siteId: "site-1", since: null,
      id: "action-1", updatedAt: "2026-10-25T00:00:00.000Z" })).toString("base64url");
    await expect(listConnectorActions(principal, { siteId: "site-1", cursor, limit: 10 })).rejects.toBeInstanceOf(ConnectorError);
  });

  it("binds a continuation cursor to its original since filter", async () => {
    const cursor = Buffer.from(JSON.stringify({ projectId: "project-1", siteId: "site-1", since: null,
      id: "action-1", updatedAt: "2026-10-25T00:00:00.000Z" })).toString("base64url");
    await expect(listConnectorActions(principal, { siteId: "site-1", since: "2026-10-24T00:00:00.000Z", cursor, limit: 10 }))
      .rejects.toBeInstanceOf(ConnectorError);
  });

  it("lists only Actions for the explicitly selected project site", async () => {
    mockDb.site.findFirst.mockImplementation(async ({ where }) => ({ id: where.id, projectId: "project-1", project: { id: "project-1" } }));
    mockDb.researchAction.findMany.mockResolvedValue([]);
    await listConnectorActions(principal, { siteId: "site-2", limit: 10 });
    expect(mockDb.site.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: "project-1", id: "site-2" },
    }));
    expect(mockDb.researchAction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: "project-1", siteId: "site-2" }),
    }));
  });
});
