import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findFirst: vi.fn() },
  researchFinding: { findMany: vi.fn() },
  researchSource: { findMany: vi.fn() },
  researchAction: { findMany: vi.fn() },
  researchPolicy: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { ConnectorError, listConnectorFindings } from "@/lib/connectors/service";

const principal = { credentialId: "cred", servicePrincipalId: "principal", workspaceId: "workspace", projectId: "project-1", scopes: ["connector:read"] };
const createdAt = new Date("2026-10-25T12:00:00.000Z");

describe("project-scoped connector findings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1", project: { id: "project-1" } });
    mockDb.researchFinding.findMany.mockResolvedValue([{
      id: "finding-1", runId: "run-1", type: "CONTENT_GAP", theme: "Booking questions",
      summary: "Readers need clear booking details.", confidence: 82, sentiment: "neutral", urgency: "medium",
      evidenceSourceIds: ["source-1", "missing-source"], suggestedActionKind: "content_update", createdAt,
      run: { policyRevision: 4, recencyDays: 30, brief: { language: "en", market: "MX" } },
    }]);
    mockDb.researchSource.findMany.mockResolvedValue([{
      id: "source-1", runId: "run-1", provider: "google_news_rss", url: "https://news.example/story",
      title: "Booking experiences", author: "Editor", community: null, publishedAt: null,
      retrievedAt: new Date("2026-10-25T11:00:00.000Z"), excerpt: "A public discussion of booking details.",
      language: null, metadata: { coverage: "sampled" }, run: { policyRevision: 4, recencyDays: 30, brief: { language: "en", market: "MX" } },
    }]);
    mockDb.researchAction.findMany.mockResolvedValue([{ id: "action-1", revision: 2, findingId: "finding-1" }]);
    mockDb.researchPolicy.findUnique.mockResolvedValue({ revision: 5, recencyDays: 14 });
  });

  it("returns finding provenance and linked Action revisions while exposing missing evidence", async () => {
    const result = await listConnectorFindings(principal, { siteId: "site-1", limit: 20 });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: "finding-1", runId: "run-1", researchPolicyRevision: 4,
      actionRefs: [{ id: "action-1", revision: 2 }], evidenceComplete: false,
      unavailableEvidenceSourceIds: ["missing-source"] });
    expect(result.findings[0].evidence[0]).toMatchObject({ id: "source-1", observedAt: "2026-10-25T11:00:00.000Z",
      market: "MX", language: "en", coverage: "sampled", researchPolicyRevision: 4, currentPolicyRevision: 5,
      recencyLimitDays: 14 });
    expect(mockDb.researchFinding.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { run: { projectId: "project-1", siteId: "site-1" } },
    }));
    expect(mockDb.researchSource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["source-1", "missing-source"] }, run: { projectId: "project-1", siteId: "site-1" } },
    }));
    expect(mockDb.researchAction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: "project-1", siteId: "site-1", findingId: { in: ["finding-1"] } },
    }));
  });

  it("binds finding cursors to project, site, run and since filters", async () => {
    const cursor = Buffer.from(JSON.stringify({ projectId: "another-project", siteId: "site-1", runId: null,
      since: null, id: "finding-1", createdAt: createdAt.toISOString() })).toString("base64url");
    await expect(listConnectorFindings(principal, { siteId: "site-1", limit: 20, cursor })).rejects.toBeInstanceOf(ConnectorError);
  });

  it("marks duplicate evidence identities invalid and emits each source once", async () => {
    const finding = {
      id: "finding-1", runId: "run-1", type: "CONTENT_GAP", theme: "Booking questions",
      summary: "Readers need clear booking details.", confidence: 82, sentiment: null, urgency: null,
      evidenceSourceIds: ["source-1", "source-1"], suggestedActionKind: null, createdAt,
      run: { policyRevision: 4, recencyDays: 30, brief: { language: "en", market: "MX" } },
    };
    mockDb.researchFinding.findMany.mockResolvedValue([finding]);
    const result = await listConnectorFindings(principal, { siteId: "site-1", limit: 20 });
    expect(result.findings[0].evidence).toHaveLength(1);
    expect(result.findings[0].invalidEvidenceReferences).toBe(true);
    expect(result.findings[0].evidenceComplete).toBe(false);
  });

  it("scopes site selection to the authenticated project", async () => {
    mockDb.site.findFirst.mockResolvedValue(null);
    await expect(listConnectorFindings(principal, { siteId: "other-site", limit: 10 })).rejects.toMatchObject({ status: 404 });
    expect(mockDb.site.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: "project-1", id: "other-site" } }));
  });
});
