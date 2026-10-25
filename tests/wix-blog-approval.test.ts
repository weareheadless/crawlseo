import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), bindingFindUnique: vi.fn(), updateMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  contentDraft: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
  connectorBinding: { findUnique: mocks.bindingFindUnique },
} }));
vi.mock("@/lib/delivery/unsplash", () => ({ findUnsplashCover: vi.fn(), importUnsplashCover: vi.fn() }));

import { approveWixBlogUpdateForDraft, createWixBlogDraftForDraft, publishWixBlogUpdateForDraft, WixBlogDeliveryError } from "@/lib/delivery/wix-blog";

const draft = {
  id: "draft-1", siteId: "site-1", actionId: "action-1", title: "A useful title", slug: "useful-title",
  metaTitle: "A useful title for owners", metaDescription: "A sufficiently detailed description for this owner review candidate.",
  excerpt: "Summary", markdown: "Candidate body", updatedAt: new Date("2026-10-25T00:00:00Z"),
  wixApprovalHash: null, wixApprovedBy: null, wixApprovedAt: null, wixApprovedRevision: null,
  action: { id: "action-1", revision: 3, targetUrl: "https://example.com/post/current" },
};

describe("Wix Blog exact candidate approval", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.bindingFindUnique.mockResolvedValue(null); });

  it("refuses publication without a persisted exact-candidate approval", async () => {
    mocks.findUnique.mockResolvedValue(draft);
    await expect(publishWixBlogUpdateForDraft("draft-1", "owner-1"))
      .rejects.toMatchObject({ name: "WixBlogDeliveryError", status: 409 });
    expect(mocks.findUnique).toHaveBeenCalledOnce();
  });

  it("binds approval to the current draft and Action revision", async () => {
    mocks.findUnique.mockResolvedValue(draft);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const result = await approveWixBlogUpdateForDraft("draft-1", "owner-1");
    expect(result).toMatchObject({ draftId: "draft-1", actionRevision: 3 });
    expect(result.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "draft-1", updatedAt: draft.updatedAt }),
      data: expect.objectContaining({ wixApprovalHash: result.candidateHash, wixApprovedBy: "owner-1", wixApprovedRevision: 3 }),
    }));
  });

  it("rejects approval if the Action target is not a Wix Blog post", async () => {
    mocks.findUnique.mockResolvedValue({ ...draft, action: { ...draft.action, targetUrl: "https://example.com/about" } });
    await expect(approveWixBlogUpdateForDraft("draft-1", "owner-1"))
      .rejects.toBeInstanceOf(WixBlogDeliveryError);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not approve a Wix candidate when HelloAda owns site execution", async () => {
    mocks.findUnique.mockResolvedValue(draft);
    mocks.bindingFindUnique.mockResolvedValue({ executor: "helloada", status: "ACTIVE" });
    await expect(approveWixBlogUpdateForDraft("draft-1", "owner-1"))
      .rejects.toMatchObject({ name: "WixBlogDeliveryError", status: 409 });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not create a Wix Blog draft when HelloAda owns site execution", async () => {
    mocks.findUnique.mockResolvedValue({ ...draft, site: { id: "site-1", domain: "example.com" } });
    mocks.bindingFindUnique.mockResolvedValue({ executor: "helloada", status: "ACTIVE" });
    await expect(createWixBlogDraftForDraft("draft-1"))
      .rejects.toMatchObject({ name: "WixBlogDeliveryError", status: 409 });
  });

  it("does not publish a Wix candidate when the site is transferring connectors", async () => {
    mocks.findUnique.mockResolvedValue(draft);
    mocks.bindingFindUnique.mockResolvedValue({ executor: "crawlseo-agent", status: "TRANSFERRING" });
    await expect(publishWixBlogUpdateForDraft("draft-1", "owner-1"))
      .rejects.toMatchObject({ name: "WixBlogDeliveryError", status: 409 });
    expect(mocks.findUnique).toHaveBeenCalledOnce();
  });
});
