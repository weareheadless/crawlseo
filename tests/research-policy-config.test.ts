import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findUnique: vi.fn() },
  siteProfile: { upsert: vi.fn() },
  researchPolicy: { upsert: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { saveResearchConfig } from "@/lib/research/policy";

describe("research targeting remains independent from canonical business facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.site.findUnique.mockResolvedValue({ id: "site-1", projectId: "project-1" });
    mockDb.siteProfile.upsert.mockResolvedValue({});
    mockDb.researchPolicy.upsert.mockResolvedValue({ id: "policy-1", revision: 2 });
  });

  it("continues to save query topics and target audience as research configuration", async () => {
    const input = { topics: ["water safety"], goals: ["qualified enquiries"], exclusions: ["medical claims"], recencyDays: 30,
      audience: "experienced divers", market: "Mexico", language: "en", providers: ["news"], cadence: "weekly" as const,
      enabled: true, maxSources: 20, monthlyBudget: 5, autoDraft: false, autoAgent: false };
    await saveResearchConfig("site-1", input);
    expect(mockDb.siteProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ topics: input.topics, audience: input.audience,
        constraints: { market: "Mexico", exclusions: input.exclusions, goals: input.goals } }),
      update: expect.objectContaining({ topics: input.topics, audience: input.audience }),
    }));
    expect(mockDb.researchPolicy.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ goals: input.goals, exclusions: input.exclusions, enabled: true }),
      update: expect.objectContaining({ goals: input.goals, exclusions: input.exclusions, enabled: true }),
    }));
  });
});
