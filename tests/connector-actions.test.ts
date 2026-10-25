import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mockDb = vi.hoisted(() => ({
  site: { findFirst: vi.fn() },
  researchAction: { findFirst: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  researchSource: { findMany: vi.fn() },
  connectorContextSnapshot: { findFirst: vi.fn() },
  researchPolicy: { findUnique: vi.fn() },
  project: { findUnique: vi.fn() },
  connectorExecutionState: { findUnique: vi.fn() },
  crawl: { findFirst: vi.fn() }, crawlIssue: { findMany: vi.fn() }, auditPage: { findMany: vi.fn() },
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
    mockDb.connectorContextSnapshot.findFirst.mockResolvedValue({ revision: "ctx-3", canonicalOrigin: "https://example.com/" });
    mockDb.researchPolicy.findUnique.mockResolvedValue({ revision: 5, recencyDays: 14 });
    mockDb.project.findUnique.mockResolvedValue({ externalProjectId: "external-1" });
    mockDb.connectorExecutionState.findUnique.mockResolvedValue(null);
    mockDb.crawl.findFirst.mockResolvedValue({ id: "crawl-1", siteId: "site-1", status: "COMPLETED",
      finishedAt: new Date("2026-10-25T11:00:00.000Z") });
    mockDb.crawlIssue.findMany.mockResolvedValue([{ id: "issue-1", crawlId: "crawl-1", url: "https://example.com/",
      type: "MISSING_TITLE", severity: "WARNING", message: "Missing title" }]);
    mockDb.auditPage.findMany.mockResolvedValue([{ id: "page-1", crawlId: "crawl-1", url: "https://example.com/",
      statusCode: 200, title: null, description: "Description", canonical: null, h1Count: 1, wordCount: 20,
      contentScore: 30, hasSchema: false, indexable: true }]);
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

  it("returns resolved technical crawl provenance as its own evidence contract", async () => {
    const sourceFingerprint = createHash("sha256").update(JSON.stringify({
      siteId: "site-1", crawlId: "crawl-1", issueIds: ["issue-1"],
    })).digest("hex");
    mockDb.researchAction.findFirst.mockResolvedValue({ ...action, finding: null, evidence: { technicalEvidence: {
      schemaVersion: "1.0", sourceKind: "crawl", siteId: "site-1", canonicalContextRevision: "ctx-3",
      canonicalOrigin: "https://example.com/", crawlId: "crawl-1", completedAt: "2026-10-25T11:00:00.000Z",
      recencyLimitDays: 7, sourceFingerprint,
      issueRefs: [{ id: "issue-1", url: "https://example.com/", type: "MISSING_TITLE", severity: "WARNING", message: "Missing title" }],
      pageRefs: [{ id: "page-1", url: "https://example.com/", statusCode: 200, title: null, description: "Description",
        canonical: null, h1Count: 1, wordCount: 20, contentScore: 30, hasSchema: false, indexable: true }],
    } } });
    mockDb.researchSource.findMany.mockResolvedValue([]);

    const result = await getConnectorAction(principal, "action-1");

    expect(result.technicalEvidenceComplete).toBe(true);
    expect(result.technicalEvidenceStale).toBe(false);
    expect(result.technicalEvidence?.issueRefs).toHaveLength(1);
    expect(result.technicalEvidence?.pageRefs[0].id).toBe("page-1");
    expect(result.evidence).toEqual([]);
    expect(result.evidenceComplete).toBe(false);
  });

  it("marks altered or unavailable crawl references invalid instead of completing them", async () => {
    const sourceFingerprint = createHash("sha256").update(JSON.stringify({
      siteId: "site-1", crawlId: "crawl-1", issueIds: ["issue-1"],
    })).digest("hex");
    mockDb.researchAction.findFirst.mockResolvedValue({ ...action, finding: null, evidence: { technicalEvidence: {
      schemaVersion: "1.0", sourceKind: "crawl", siteId: "site-1", canonicalContextRevision: "ctx-3",
      canonicalOrigin: "https://example.com/", crawlId: "crawl-1", completedAt: "2026-10-25T11:00:00.000Z",
      recencyLimitDays: 7, sourceFingerprint,
      issueRefs: [{ id: "issue-1", url: "https://example.com/", type: "MISSING_TITLE", severity: "INFO", message: "Missing title" }],
      pageRefs: [],
    } } });
    mockDb.researchSource.findMany.mockResolvedValue([]);

    const result = await getConnectorAction(principal, "action-1");

    expect(result.technicalEvidenceComplete).toBe(false);
    expect(result.invalidTechnicalEvidenceReferences).toBe(true);
  });

  it("marks crawl provenance incomplete when the canonical context has changed", async () => {
    const sourceFingerprint = createHash("sha256").update(JSON.stringify({
      siteId: "site-1", crawlId: "crawl-1", issueIds: ["issue-1"],
    })).digest("hex");
    mockDb.researchAction.findFirst.mockResolvedValue({ ...action, finding: null, evidence: { technicalEvidence: {
      schemaVersion: "1.0", sourceKind: "crawl", siteId: "site-1", canonicalContextRevision: "ctx-old",
      canonicalOrigin: "https://example.com/", crawlId: "crawl-1", completedAt: "2026-10-25T11:00:00.000Z",
      recencyLimitDays: 7, sourceFingerprint,
      issueRefs: [{ id: "issue-1", url: "https://example.com/", type: "MISSING_TITLE", severity: "WARNING", message: "Missing title" }],
      pageRefs: [{ id: "page-1", url: "https://example.com/", statusCode: 200, title: null, description: "Description",
        canonical: null, h1Count: 1, wordCount: 20, contentScore: 30, hasSchema: false, indexable: true }],
    } } });
    mockDb.researchSource.findMany.mockResolvedValue([]);

    const result = await getConnectorAction(principal, "action-1");

    expect(result.technicalEvidenceComplete).toBe(false);
    expect(result.invalidTechnicalEvidenceReferences).toBe(true);
  });

  it("reports web and competitor research as unsupported", async () => {
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1",
      project: { id: "project-1", externalProjectId: "external-1", workspaceId: "workspace" },
      connectorBinding: { executor: "helloada", generation: 2, status: "ACTIVE" } });
    const result = await connectorCapabilities(principal, "site-1");
    expect(result.capabilities).toContain("findings.read");
    expect(result.capabilities).not.toContain("providers.web-news-rss");
    expect(result.researchProviders).toContainEqual({ id: "web", supported: false,
      reason: "General web search is not implemented; Google News RSS is available through the news provider" });
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
