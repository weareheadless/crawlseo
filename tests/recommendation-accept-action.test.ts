import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accept: vi.fn(async () => "task-1"),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  revalidatePath: vi.fn(),
  getUserId: vi.fn(async () => "u1"),
  userFind: vi.fn(async () => ({ email: "dana@example.com", name: "Dana" })),
  siteFind: vi.fn(async () => ({ userId: "u1", projectId: "p1" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/session-helper", () => ({ getUserIdFromCookies: mocks.getUserId }));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: mocks.userFind },
    site: { findUnique: mocks.siteFind },
  },
}));
vi.mock("@/lib/funnel/accept", () => ({ acceptOpportunityForSite: mocks.accept }));
vi.mock("@/lib/funnel/join", () => ({
  recordAgentPreparation: vi.fn(),
  confirmHumanStep: vi.fn(),
}));
vi.mock("@/lib/funnel/backfill", () => ({ refreshFunnelForSite: vi.fn() }));
vi.mock("@/lib/funnel/opportunity", () => ({ decideOpportunity: vi.fn() }));

describe("accept opportunity action", () => {
  it("forwards the render-time decision version and site scope to the acceptance gate", async () => {
    const { acceptOpportunityAction } = await import(
      "@/app/(dashboard)/sites/[siteId]/opportunities/actions"
    );
    await expect(acceptOpportunityAction("s1", "op1", "decision-1")).rejects.toThrow(/redirect:/);
    expect(mocks.accept).toHaveBeenCalledWith(expect.anything(), {
      siteId: "s1",
      opportunityId: "op1",
      assignedTo: "Dana",
      expectedDecisionId: "decision-1",
    });
  });
});
