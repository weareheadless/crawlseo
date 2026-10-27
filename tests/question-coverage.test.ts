import { beforeEach, describe, expect, it, vi } from "vitest";

const { mock } = vi.hoisted(() => ({ mock: { finding: vi.fn(), revision: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), draft: vi.fn(), coverageUpdate: vi.fn(), action: vi.fn(), actionFind: vi.fn(), actionUpdate: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: { contentDraft: { findUnique: mock.draft }, researchFinding: { findFirst: mock.finding, findUnique: mock.finding }, businessKnowledgeRevision: { findFirst: mock.revision },
  researchAction: { findUnique: mock.actionFind }, questionCoverage: { findUnique: mock.findUnique, upsert: mock.upsert, update: mock.coverageUpdate } } }));
vi.mock("@/lib/research/service", () => ({ createResearchAction: mock.action, updateResearchAction: mock.actionUpdate }));
import { hashContentDraft, recordDraftCoverage, recordQuestionCoverage } from "@/lib/research/question-coverage";

const base = { projectId: "p", findingId: "f", evidence: { documentId: "d", fieldPath: "service", revision: 2 },
  section: { key: "faq:service", contentHash: "hash-1" }, service: "repair", audience: "owners", locale: "en-US", status: "covered" as const };

beforeEach(() => {
  vi.clearAllMocks(); mock.finding.mockResolvedValue({ id: "f", summary: "Question about proof?", theme: "repair", runId: "r", run: { siteId: "s" } });
  mock.revision.mockResolvedValue({ fields: { service: { value: "Repairs", provenance: { status: "owner_confirmed" }, publicationUse: "approved" } } });
  mock.findUnique.mockResolvedValue(null); mock.upsert.mockImplementation(async (args) => ({ id: "c", ...args.create, ...args.update }));
  mock.action.mockResolvedValue({ action: { id: "a", status: "PROPOSED" }, created: true });
  mock.coverageUpdate.mockImplementation(async (args) => ({ id: "c", ...args.data }));
  mock.actionFind.mockResolvedValue({ id: "a", status: "PROPOSED" }); mock.actionUpdate.mockResolvedValue({ id: "a", status: "DISMISSED" });
});

describe("question coverage", () => {
  it("covers a sourced pain point against explicit service/audience/section/hash", async () => {
    const row = await recordQuestionCoverage(base);
    expect(row).toMatchObject({ status: "COVERED", service: "repair", audience: "owners", sectionIdentity: "faq:service", contentHash: "hash-1", documentId: "d", fieldPath: "service", evidenceRevision: 2 });
  });
  it("does not allow URL/title-only evidence to become covered", async () => {
    mock.revision.mockResolvedValue({ fields: {} });
    await expect(recordQuestionCoverage(base)).rejects.toThrow(/field or provenance/);
  });
  it("keeps disputed evidence unresolved with an information request", async () => {
    mock.revision.mockResolvedValue({ fields: { service: { value: "Repairs", provenance: { status: "disputed" }, publicationUse: "approved" } } });
    const row = await recordQuestionCoverage(base);
    expect(row).toMatchObject({ status: "UNRESOLVED", reason: "DISPUTED_EVIDENCE", missingEvidence: expect.any(String) });
    expect(mock.action).toHaveBeenCalledTimes(1);
    expect(mock.action.mock.calls[0][1].recommendation).toContain("does not assert the underlying fact");
  });
  it("deduplicates repeated unresolved coverage by its identity", async () => {
    mock.revision.mockResolvedValue({ fields: { service: { provenance: { status: "disputed" }, publicationUse: "approved" } } });
    await recordQuestionCoverage({ ...base, status: "unresolved", missingEvidence: "Provide verified evidence" });
    await recordQuestionCoverage({ ...base, status: "unresolved", missingEvidence: "Provide verified evidence" });
    expect(mock.action).toHaveBeenCalledTimes(2);
    expect(mock.action.mock.calls[0][1].dedupeKey).toBe(mock.action.mock.calls[1][1].dedupeKey);
  });
  it("closes the originating Action on covered evidence and leaves an unresolvable request open", async () => {
    mock.revision.mockResolvedValue({ fields: { service: { provenance: { status: "disputed" }, publicationUse: "approved" } } });
    await recordQuestionCoverage({ ...base, status: "unresolved", missingEvidence: "Provide verified evidence" });
    expect(mock.action.mock.calls[0][1].evidence.outcome).toBe("unknown_until_coverage_resolves");
    mock.revision.mockResolvedValue({ fields: { service: { value: "Repairs", provenance: { status: "owner_confirmed" }, publicationUse: "approved" } } });
    mock.upsert.mockResolvedValue({ id: "c", actionId: "a", status: "COVERED" });
    await recordQuestionCoverage(base);
    expect(mock.actionUpdate).toHaveBeenCalledWith("a", { status: "FULFILLED" }, "system:question-coverage");
    mock.actionUpdate.mockClear();
    mock.revision.mockResolvedValue({ fields: { service: { provenance: { status: "disputed" }, publicationUse: "approved" } } });
    await recordQuestionCoverage({ ...base, status: "unresolved", missingEvidence: "Still needed" });
    expect(mock.actionUpdate).not.toHaveBeenCalled();
  });
  it("keeps rejection and failure distinct from fulfillment", async () => {
    expect(mock.actionUpdate).not.toHaveBeenCalled();
    mock.upsert.mockResolvedValue({ id: "c", actionId: "a", status: "COVERED" });
    mock.actionFind.mockResolvedValue({ id: "a", status: "DISMISSED" });
    await recordQuestionCoverage(base);
    expect(mock.actionUpdate).not.toHaveBeenCalled();
    mock.actionFind.mockResolvedValue({ id: "a", status: "FAILED" });
    await recordQuestionCoverage(base);
    expect(mock.actionUpdate).not.toHaveBeenCalled();
  });
  it("invalidates coverage when section hash changes", async () => {
    mock.findUnique.mockResolvedValue({ contentHash: "old" });
    const row = await recordQuestionCoverage({ ...base, section: { key: "faq:service", contentHash: "new" } });
    expect(row).toMatchObject({ status: "UNRESOLVED", reason: "STALE_HASH", contentHash: "new" });
  });
  it("upserts by project/finding/section on replay", async () => {
    await recordQuestionCoverage(base); await recordQuestionCoverage(base);
    expect(mock.upsert).toHaveBeenCalledTimes(2);
    expect(mock.upsert.mock.calls[0][0].where).toEqual(mock.upsert.mock.calls[1][0].where);
  });
  it("binds accepted draft coverage to its exact deterministic content and reports unlinked questions", async () => {
    const content = { id: "draft-1", siteId: "s", actionId: "a", title: "Title", slug: "slug", metaTitle: "Meta", metaDescription: "Description", excerpt: "Excerpt", markdown: "# Answer" };
    mock.draft.mockResolvedValue({ ...content, action: { id: "a", findingId: "f", projectId: "p" }, site: { projectId: "p" } });
    mock.finding.mockResolvedValue({ id: "f", summary: "Which services are available?", theme: "repair", runId: "r", run: { siteId: "s" } });
    mock.revision.mockResolvedValue(null);
    mock.upsert.mockImplementation(async (args) => args.create);
    const row = await recordDraftCoverage("draft-1");
    expect(row).toMatchObject({ status: "UNRESOLVED", sectionIdentity: "draft-1", contentHash: hashContentDraft(content), reason: "NO_EVIDENCE", missingEvidence: expect.stringContaining("Which services") });
  });
  it("marks changed draft content stale and updates the same coverage identity", async () => {
    const content = { id: "draft-1", siteId: "s", actionId: "a", title: "Title", slug: "slug", metaTitle: "Meta", metaDescription: "Description", excerpt: "Excerpt", markdown: "Changed markdown" };
    mock.draft.mockResolvedValue({ ...content, action: { id: "a", findingId: "f", projectId: "p" }, site: { projectId: "p" } });
    mock.finding.mockResolvedValue({ id: "f", summary: "Question?", theme: "repair", runId: "r", run: { siteId: "s" } });
    mock.revision.mockResolvedValue(null);
    mock.findUnique.mockResolvedValue({ contentHash: "previous-hash" });
    mock.upsert.mockImplementation(async (args) => ({ id: "c", ...args.update }));
    const row = await recordDraftCoverage("draft-1");
    expect(row).toMatchObject({ status: "UNRESOLVED", reason: "STALE_HASH", contentHash: hashContentDraft(content) });
  });
});
