import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ user: vi.fn(), owns: vi.fn(), draft: vi.fn(), coverage: vi.fn() }));
vi.mock("@/lib/session-helper", () => ({ getUserIdFromCookies: h.user }));
vi.mock("@/lib/auth/research-action-access", () => ({ userOwnsSite: h.owns }));
vi.mock("@/lib/db", () => ({ db: { contentDraft: { findFirst: h.draft } } }));
vi.mock("@/lib/research/question-coverage", () => ({ recordDraftCoverage: h.coverage }));
import { POST } from "@/app/api/sites/[siteId]/content-drafts/[draftId]/accept/route";

const params = { params: Promise.resolve({ siteId: "site-1", draftId: "draft-1" }) };
beforeEach(() => { vi.clearAllMocks(); h.user.mockResolvedValue("user-1"); h.owns.mockResolvedValue(true); h.draft.mockResolvedValue({ id: "draft-1" }); h.coverage.mockResolvedValue({ status: "COVERED", contentHash: "exact-hash", missingEvidence: null, actionId: null }); });

describe("provider-neutral draft acceptance route", () => {
  it("records explicit evidence and returns the section hash", async () => {
    const req = new Request("http://local", { method: "POST", body: JSON.stringify({ evidence: { documentId: "doc", fieldPath: "services", revision: 4 } }) });
    const response = await POST(req, params);
    expect(h.coverage).toHaveBeenCalledWith("draft-1", { documentId: "doc", fieldPath: "services", revision: 4 });
    expect(await response.json()).toMatchObject({ outcome: "covered", coverage: { sectionHash: "exact-hash" } });
  });
  it("records unresolved coverage when evidence is omitted", async () => {
    h.coverage.mockResolvedValue({ status: "UNRESOLVED", contentHash: "hash", missingEvidence: "Provide evidence", actionId: "action-1" });
    const response = await POST(new Request("http://local", { method: "POST" }), params);
    expect(h.coverage).toHaveBeenCalledWith("draft-1", undefined);
    expect(await response.json()).toMatchObject({ outcome: "unresolved", coverage: { missingEvidence: "Provide evidence", actionId: "action-1" } });
  });
  it("404s when the requested draft is not scoped to the site", async () => {
    h.draft.mockResolvedValue(null);
    expect((await POST(new Request("http://local", { method: "POST" }), params)).status).toBe(404);
    expect(h.coverage).not.toHaveBeenCalled();
  });
});
