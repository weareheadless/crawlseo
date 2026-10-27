import { beforeEach, describe, expect, it, vi } from "vitest";

const { mock } = vi.hoisted(() => ({ mock: { finding: vi.fn(), revision: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), draft: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: { contentDraft: { findUnique: mock.draft }, researchFinding: { findFirst: mock.finding, findUnique: mock.finding }, businessKnowledgeRevision: { findFirst: mock.revision },
  questionCoverage: { findUnique: mock.findUnique, upsert: mock.upsert } } }));
import { hashContentDraft, recordDraftCoverage, recordQuestionCoverage } from "@/lib/research/question-coverage";

const base = { projectId: "p", findingId: "f", evidence: { documentId: "d", fieldPath: "service", revision: 2 },
  section: { key: "faq:service", contentHash: "hash-1" }, service: "repair", audience: "owners", locale: "en-US", status: "covered" as const };

beforeEach(() => {
  vi.clearAllMocks(); mock.finding.mockResolvedValue({ id: "f" });
  mock.revision.mockResolvedValue({ fields: { service: { value: "Repairs", provenance: { status: "owner_confirmed" }, publicationUse: "approved" } } });
  mock.findUnique.mockResolvedValue(null); mock.upsert.mockImplementation(async (args) => args.create);
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
    mock.finding.mockResolvedValue({ id: "f", summary: "Which services are available?", theme: "repair" });
    mock.revision.mockResolvedValue(null);
    mock.upsert.mockImplementation(async (args) => args.create);
    const row = await recordDraftCoverage("draft-1");
    expect(row).toMatchObject({ status: "UNRESOLVED", sectionIdentity: "draft-1", contentHash: hashContentDraft(content), reason: "NO_EVIDENCE", missingEvidence: expect.stringContaining("Which services") });
  });
  it("marks changed draft content stale and updates the same coverage identity", async () => {
    const content = { id: "draft-1", siteId: "s", actionId: "a", title: "Title", slug: "slug", metaTitle: "Meta", metaDescription: "Description", excerpt: "Excerpt", markdown: "Changed markdown" };
    mock.draft.mockResolvedValue({ ...content, action: { id: "a", findingId: "f", projectId: "p" }, site: { projectId: "p" } });
    mock.finding.mockResolvedValue({ id: "f", summary: "Question?", theme: "repair" });
    mock.revision.mockResolvedValue(null);
    mock.findUnique.mockResolvedValue({ contentHash: "previous-hash" });
    mock.upsert.mockImplementation(async (args) => args.update);
    const row = await recordDraftCoverage("draft-1");
    expect(row).toMatchObject({ status: "UNRESOLVED", reason: "STALE_HASH", contentHash: hashContentDraft(content) });
  });
});
