import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(), site: { findFirst: vi.fn() }, connectorBinding: { findUnique: vi.fn() },
    connectorContextSnapshot: { findFirst: vi.fn() }, crawl: { findFirst: vi.fn() },
    crawlIssue: { findMany: vi.fn() }, auditPage: { findMany: vi.fn() },
    connectorOperationReceipt: { findUnique: vi.fn(), create: vi.fn() }, agentTask: { findFirst: vi.fn() },
    researchAction: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    connectorExecutionState: { findUnique: vi.fn() }, connectorEventCounter: { upsert: vi.fn(), update: vi.fn() },
    connectorEvent: { create: vi.fn() },
  },
  db: { $transaction: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));

import { reassessTechnicalActionGroup, technicalReassessmentRequestHash, TechnicalActionError } from "@/lib/crawler/technical-actions";

const baseInput = {
  projectId: "project-1", siteId: "site-1", crawlId: "crawl-1", expectedBindingGeneration: 3,
  expectedContextRevision: "ctx-9", issueIds: ["issue-1", "issue-2"],
  operatorRequestId: "operator-request-1", reason: "Refresh evidence after owner review request",
};
const finishedAt = new Date(Date.now() - 60_000);
const issues = ["issue-1", "issue-2"].map((id, index) => ({ id, crawlId: "crawl-1",
  url: index ? "https://example.com/blog" : "https://example.com/", type: "DUPLICATE_TITLE", severity: "WARNING",
  message: "Duplicate title shared by 2 pages", details: { title: "Example", urls: ["https://example.com/", "https://example.com/blog"], howToFix: "ignored operator text" },
}));
const pages = ["https://example.com/", "https://example.com/blog"].map((url, index) => ({ id: `page-${index + 1}`,
  crawlId: "crawl-1", url, statusCode: 200, title: "Example", description: "Description", canonical: null,
  h1Count: 1, wordCount: 100, contentScore: 80, hasSchema: false, indexable: true,
}));

describe("technical crawl Action reassessment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.$queryRaw.mockResolvedValue([]);
    mocks.tx.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1", domain: "example.com" });
    mocks.tx.connectorBinding.findUnique.mockResolvedValue({ projectId: "project-1", status: "ACTIVE", generation: 3, executor: "helloada" });
    mocks.tx.connectorOperationReceipt.findUnique.mockResolvedValue(null);
    mocks.tx.connectorOperationReceipt.create.mockResolvedValue({});
    mocks.tx.agentTask.findFirst.mockResolvedValue(null);
    mocks.tx.connectorContextSnapshot.findFirst.mockResolvedValue({ revision: "ctx-9", observedAt: new Date(),
      canonicalOrigin: "https://example.com/", websiteInventory: [{ route: "/" }, { route: "/blog" }],
      capabilities: { supported: ["content.prepare"], sourceFiles: [] },
    });
    mocks.tx.crawl.findFirst.mockResolvedValue({ id: "crawl-1", siteId: "site-1", status: "COMPLETED", finishedAt });
    mocks.tx.crawlIssue.findMany.mockResolvedValue(issues);
    mocks.tx.auditPage.findMany.mockResolvedValue(pages);
    mocks.tx.researchAction.findUnique.mockResolvedValue(null);
    mocks.tx.researchAction.create.mockImplementation(async ({ data }) => ({ id: "new-action", revision: 1, status: "PROPOSED", ...data }));
    mocks.tx.connectorExecutionState.findUnique.mockResolvedValue(null);
    mocks.tx.connectorEventCounter.upsert.mockResolvedValue({ sequence: 1 });
    mocks.tx.connectorEventCounter.update.mockResolvedValue({ sequence: 2 });
    mocks.tx.connectorEvent.create.mockResolvedValue({});
  });

  it("creates an exact typed crawl provenance revision without ResearchSource coercion", async () => {
    const result = await reassessTechnicalActionGroup(baseInput);
    const create = mocks.tx.researchAction.create.mock.calls[0][0].data;
    expect(result).toMatchObject({ reused: false, action: { id: "new-action", revision: 1 } });
    expect(create.source).toBe("crawl_issue");
    expect(create.title).toContain("2 pages");
    expect(create.acceptanceCriteria[0]).toContain("does not resolve other affected pages");
    expect(create.recommendation).toContain("Prepare only the title for https://example.com/");
    expect(create.runId).toBeNull();
    expect(create.findingId).toBeNull();
    expect(create.evidence.technicalEvidence).toMatchObject({
      schemaVersion: "1.0", sourceKind: "crawl", siteId: "site-1", crawlId: "crawl-1",
      canonicalContextRevision: "ctx-9", canonicalOrigin: "https://example.com/",
      completedAt: finishedAt.toISOString(), recencyLimitDays: 7,
      issueRefs: [{ id: "issue-1", type: "DUPLICATE_TITLE" }, { id: "issue-2", type: "DUPLICATE_TITLE" }],
      pageRefs: [{ id: "page-1" }, { id: "page-2" }],
    });
    expect(create.evidence.source_ids).toBeUndefined();
    expect(create.requiredCapabilities).toEqual(["content.prepare"]);
    expect(mocks.tx.connectorEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "action.created", actionRevision: 1,
        payload: expect.objectContaining({ technicalEvidence: create.evidence.technicalEvidence }) }),
    }));
  });

  it("rejects issue references from another crawl rather than resolving by URL or title", async () => {
    mocks.tx.crawlIssue.findMany.mockResolvedValue([issues[0]]);
    await expect(reassessTechnicalActionGroup(baseInput)).rejects.toMatchObject({
      message: "One or more issue IDs do not belong to the selected completed crawl",
    });
    expect(mocks.tx.researchAction.create).not.toHaveBeenCalled();
  });

  it("rejects a partial duplicate group instead of silently omitting its other persisted issues", async () => {
    mocks.tx.crawlIssue.findMany.mockImplementation(async ({ where }) => where.id ? [issues[0]] : issues);
    await expect(reassessTechnicalActionGroup({ ...baseInput, issueIds: ["issue-1"] })).rejects.toMatchObject({
      message: "Selected issue IDs do not cover the exact persisted crawl issue group",
    });
    expect(mocks.tx.researchAction.create).not.toHaveBeenCalled();
  });

  it("requires the current canonical context revision and exact supported target capability", async () => {
    mocks.tx.connectorContextSnapshot.findFirst.mockResolvedValue({ revision: "newer", observedAt: new Date(),
      canonicalOrigin: "https://example.com/", websiteInventory: [{ route: "/" }],
      capabilities: { supported: [], sourceFiles: [] },
    });
    await expect(reassessTechnicalActionGroup(baseInput)).rejects.toBeInstanceOf(TechnicalActionError);
    expect(mocks.tx.crawl.findFirst).not.toHaveBeenCalled();

    mocks.tx.connectorContextSnapshot.findFirst.mockResolvedValue({ revision: "ctx-9", observedAt: new Date(),
      canonicalOrigin: "https://example.com/", websiteInventory: [{ route: "/" }],
      capabilities: { supported: [], sourceFiles: [] },
    });
    await expect(reassessTechnicalActionGroup(baseInput)).rejects.toMatchObject({
      message: "The current connector context does not support bounded page preparation",
    });
  });

  it("requires the registered HelloAda executor and a bare HTTPS context origin", async () => {
    mocks.tx.connectorBinding.findUnique.mockResolvedValue({ projectId: "project-1", status: "ACTIVE", generation: 3, executor: "other" });
    await expect(reassessTechnicalActionGroup(baseInput)).rejects.toMatchObject({
      message: "Active connector binding changed; refresh before reassessment",
    });
    mocks.tx.connectorBinding.findUnique.mockResolvedValue({ projectId: "project-1", status: "ACTIVE", generation: 3, executor: "helloada" });
    mocks.tx.connectorContextSnapshot.findFirst.mockResolvedValue({ revision: "ctx-9", observedAt: new Date(),
      canonicalOrigin: "https://example.com/path", websiteInventory: [], capabilities: { supported: [], sourceFiles: [] } });
    await expect(reassessTechnicalActionGroup(baseInput)).rejects.toMatchObject({
      message: "Connector context does not match the registered canonical site origin",
    });
  });

  it("requires persisted AuditPage lineage for every affected Payload route", async () => {
    mocks.tx.auditPage.findMany.mockResolvedValue([pages[0]]);
    await expect(reassessTechnicalActionGroup(baseInput)).rejects.toMatchObject({
      message: "The completed crawl has no persisted AuditPage record for every affected Payload route",
    });
    expect(mocks.tx.researchAction.create).not.toHaveBeenCalled();
  });

  it("rejects future crawl observations and unsupported technical remediation types", async () => {
    mocks.tx.crawl.findFirst.mockResolvedValue({ id: "crawl-1", siteId: "site-1", status: "COMPLETED", finishedAt: new Date(Date.now() + 1000) });
    await expect(reassessTechnicalActionGroup(baseInput)).rejects.toMatchObject({
      message: "Selected crawl is outside the explicit 7-day technical evidence window",
    });
    mocks.tx.crawl.findFirst.mockResolvedValue({ id: "crawl-1", siteId: "site-1", status: "COMPLETED", finishedAt });
    mocks.tx.crawlIssue.findMany.mockImplementation(async ({ where }) => where.id ? [{ ...issues[0], type: "MISSING_SCHEMA" }] : [{ ...issues[0], type: "MISSING_SCHEMA" }]);
    await expect(reassessTechnicalActionGroup({ ...baseInput, issueIds: ["issue-1"] })).rejects.toMatchObject({
      message: "This crawl issue type has no bounded Payload metadata remediation; it cannot be made preparable",
    });
  });

  it("requires an exact declared sitemap source file for sitemap Actions", async () => {
    mocks.tx.connectorContextSnapshot.findFirst.mockResolvedValue({ revision: "ctx-9", observedAt: new Date(),
      canonicalOrigin: "https://example.com/", websiteInventory: [],
      capabilities: { supported: ["site_metadata.sitemap"], sourceFiles: ["public/sitemap.xml"] },
    });
    const sitemapIssue = { id: "sitemap-issue", crawlId: "crawl-1", url: "https://example.com/sitemap.xml",
      type: "MISSING_SITEMAP", severity: "WARNING", message: "No sitemap found", details: {} };
    mocks.tx.crawlIssue.findMany.mockResolvedValue([sitemapIssue]);
    mocks.tx.auditPage.findMany.mockResolvedValue([]);

    await reassessTechnicalActionGroup({ ...baseInput, issueIds: ["sitemap-issue"] });

    const data = mocks.tx.researchAction.create.mock.calls[0][0].data;
    expect(data.targetUrl).toBe("https://example.com/sitemap.xml");
    expect(data.requiredCapabilities).toEqual(["site_metadata.sitemap"]);
    expect(data.evidence.target_identity).toEqual({ kind: "source_file", path: "public/sitemap.xml" });

    vi.clearAllMocks();
    mocks.db.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.$queryRaw.mockResolvedValue([]);
    mocks.tx.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1", domain: "example.com" });
    mocks.tx.connectorBinding.findUnique.mockResolvedValue({ projectId: "project-1", status: "ACTIVE", generation: 3, executor: "helloada" });
    mocks.tx.connectorOperationReceipt.findUnique.mockResolvedValue(null);
    mocks.tx.connectorOperationReceipt.create.mockResolvedValue({});
    mocks.tx.agentTask.findFirst.mockResolvedValue(null);
    mocks.tx.connectorContextSnapshot.findFirst.mockResolvedValue({ revision: "ctx-9", observedAt: new Date(),
      canonicalOrigin: "https://example.com/", websiteInventory: [],
      capabilities: { supported: ["site_metadata.sitemap"], sourceFiles: ["private/sitemap.xml"] },
    });
    mocks.tx.crawl.findFirst.mockResolvedValue({ id: "crawl-1", siteId: "site-1", status: "COMPLETED", finishedAt });
    mocks.tx.crawlIssue.findMany.mockResolvedValue([sitemapIssue]);
    await expect(reassessTechnicalActionGroup({ ...baseInput, issueIds: ["sitemap-issue"] })).rejects.toMatchObject({
      message: "The current connector context does not support editing sitemap.xml",
    });
  });

  it("requires explicit Action ID and revision for a legacy row reassessment", async () => {
    await expect(reassessTechnicalActionGroup({ ...baseInput, existingActionId: "legacy" }))
      .rejects.toMatchObject({ message: "Existing Action reassessment requires both Action ID and expected revision" });
  });

  it("does not replace a legacy Action while a candidate awaits an owner decision", async () => {
    const legacy = { id: "legacy", siteId: "site-1", projectId: "project-1", source: "crawl_issue", revision: 4,
      title: "Old title", recommendation: "Old recommendation", evidence: { crawl_id: "crawl-1" }, status: "PROPOSED",
      priority: 50, preparationStatus: "NONE", dedupeKey: "old-key", _count: { drafts: 0, deliveries: 0 } };
    mocks.tx.researchAction.findFirst.mockResolvedValue(legacy);
    mocks.tx.connectorExecutionState.findUnique.mockResolvedValue({ status: "owner_decision", ownerDecision: "approved" });
    await expect(reassessTechnicalActionGroup({ ...baseInput, existingActionId: "legacy", expectedActionRevision: 4 }))
      .rejects.toMatchObject({ message: "An Action with an exact owner decision, execution, candidate, review, or active task cannot be reassessed" });
    expect(mocks.tx.researchAction.update).not.toHaveBeenCalled();
  });

  it("blocks reassessment while an AgentTask is active", async () => {
    const legacy = { id: "legacy", siteId: "site-1", projectId: "project-1", source: "crawl_issue", revision: 4,
      title: "Old title", recommendation: "Old recommendation", evidence: { crawl_id: "crawl-1" }, status: "PROPOSED",
      priority: 50, preparationStatus: "NONE", dedupeKey: "old-key", _count: { drafts: 0, deliveries: 0 } };
    mocks.tx.researchAction.findFirst.mockResolvedValue(legacy);
    mocks.tx.agentTask.findFirst.mockResolvedValue({ id: "task-1" });
    await expect(reassessTechnicalActionGroup({ ...baseInput, existingActionId: "legacy", expectedActionRevision: 4 }))
      .rejects.toMatchObject({ message: "An Action with an exact owner decision, execution, candidate, review, or active task cannot be reassessed" });
    expect(mocks.tx.researchAction.update).not.toHaveBeenCalled();
  });

  it("persists operator request idempotency and rejects reuse with changed input", async () => {
    const completed = { id: "new-action", revision: 1, siteId: "site-1", projectId: "project-1", status: "PROPOSED" };
    mocks.tx.connectorOperationReceipt.findUnique.mockResolvedValue({ requestHash: "different", actionId: "new-action", actionRevision: 1 });
    mocks.tx.researchAction.findFirst.mockResolvedValue(completed);
    await expect(reassessTechnicalActionGroup(baseInput)).rejects.toMatchObject({
      message: "Operator request ID was already used with different reassessment inputs",
    });
    expect(mocks.tx.researchAction.create).not.toHaveBeenCalled();
  });

  it("replays the same durable operator request without creating another revision", async () => {
    const completed = { id: "new-action", revision: 1, siteId: "site-1", projectId: "project-1", status: "PROPOSED" };
    mocks.tx.connectorOperationReceipt.findUnique.mockResolvedValue({
      requestHash: technicalReassessmentRequestHash(baseInput), actionId: "new-action", actionRevision: 1,
    });
    mocks.tx.researchAction.findFirst.mockResolvedValue(completed);

    await expect(reassessTechnicalActionGroup(baseInput)).resolves.toEqual({ action: completed, reused: true });
    expect(mocks.tx.researchAction.create).not.toHaveBeenCalled();
    expect(mocks.tx.connectorOperationReceipt.create).not.toHaveBeenCalled();
  });

  it("creates a new Action revision only for an explicitly selected legacy Action and expected revision", async () => {
    const legacy = { id: "legacy", siteId: "site-1", projectId: "project-1", source: "crawl_issue", revision: 4,
      title: "Old title", recommendation: "Old recommendation", evidence: { crawl_id: "crawl-1" }, status: "PROPOSED",
      priority: 50, preparationStatus: "NONE", dedupeKey: "old-key", _count: { drafts: 0, deliveries: 0 } };
    mocks.tx.researchAction.findFirst.mockResolvedValue(legacy);
    mocks.tx.researchAction.update.mockImplementation(async ({ data }) => ({ ...legacy, ...data, revision: 5, status: "PROPOSED" }));

    const result = await reassessTechnicalActionGroup({ ...baseInput, existingActionId: "legacy", expectedActionRevision: 4 });

    expect(result.action.id).toBe("legacy");
    expect(result.action.revision).toBe(5);
    expect(mocks.tx.researchAction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "legacy" }, data: expect.objectContaining({ revision: { increment: 1 }, evidence: expect.objectContaining({
        technicalEvidence: expect.objectContaining({ crawlId: "crawl-1", issueRefs: expect.arrayContaining([expect.objectContaining({ id: "issue-1" })]) }),
      }) }),
    }));
    expect(mocks.tx.connectorEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "action.revision.superseded", actionRevision: 4 }),
    }));
  });
});
