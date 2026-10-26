import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findUnique: vi.fn(), findMany: vi.fn() },
  researchAction: { findMany: vi.fn(), update: vi.fn() },
}));
const mockPlan = vi.hoisted(() => ({ getContentActionPlan: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/ai-seo/content-plan", () => mockPlan);
vi.mock("@/lib/editorial/review", () => ({
  editorialFingerprint: vi.fn(),
  reviewSeoOpportunity: vi.fn(),
}));

import { syncSeoOpportunitiesToActions } from "@/lib/research/seo-actions";

describe("SEO Action production authority", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not produce a second Action set for a superseded duplicate site", async () => {
    mockDb.site.findUnique.mockResolvedValue({ id: "site-legacy", projectId: "project-1", domain: "oceanicvibes.com",
      connectorBinding: null });
    mockDb.site.findMany.mockResolvedValue([
      { projectId: "project-1", domain: "oceanicvibes.com", connectorBinding: { status: "ACTIVE", executor: "helloada" } },
    ]);

    await expect(syncSeoOpportunitiesToActions("site-legacy")).resolves.toEqual({
      created: 0, updated: 0, dismissed: 0, existing: 0, total: 0,
      skipped: "superseded_by_external_authority",
    });
    expect(mockPlan.getContentActionPlan).not.toHaveBeenCalled();
    expect(mockDb.researchAction.findMany).not.toHaveBeenCalled();
  });
});
