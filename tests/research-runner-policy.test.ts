import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  researchRun: { findUnique: vi.fn(), count: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/research/providers/reddit-rss", () => ({ fetchRedditRssSearch: vi.fn() }));
vi.mock("@/lib/research/providers/google-news-rss", () => ({ fetchGoogleNewsRssSearch: vi.fn() }));
vi.mock("@/lib/research/service", () => ({
  createResearchAction: vi.fn(), createResearchFinding: vi.fn(), researchMonthBounds: vi.fn(() => ({
    start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z"),
  })), saveResearchSources: vi.fn(),
}));
vi.mock("@/lib/agent-tasks/service", () => ({ createAgentTaskForAction: vi.fn() }));
vi.mock("@/lib/research/content", () => ({ generateDraftForAction: vi.fn() }));
vi.mock("@/lib/research/automation", () => ({ autoAgentDecision: vi.fn() }));
vi.mock("@/lib/research/synthesizer", () => ({ synthesizeResearch: vi.fn() }));
vi.mock("@/lib/research/locale", () => ({ researchCountry: vi.fn(() => "MX") }));
vi.mock("@/lib/connectors/events", () => ({ emitConnectorEvent: vi.fn() }));

import { runResearchRun } from "@/lib/research/runner";

const run = {
  id: "run-1", status: "QUEUED", siteId: "site-1", policyRevision: 3,
  providerSet: ["reddit"], recencyDays: 30, topics: ["topic"], brief: { language: "en" },
  site: { id: "site-1", domain: "example.com", projectId: "project-1", project: { researchBudgetTimeZone: "UTC" },
    connectorBinding: null, siteProfile: { constraints: {} },
    researchPolicy: { revision: 4, enabled: true, providers: ["reddit"], monthlyBudget: 9, maxSources: 30, recencyDays: 30 } },
  findings: [],
};

describe("queued research run policy fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.researchRun.findUnique.mockResolvedValue(run);
    mockDb.researchRun.count.mockResolvedValue(1);
  });

  it("does not dispatch a run created under an older policy revision", async () => {
    await expect(runResearchRun("run-1")).rejects.toThrow(
      "Research policy changed before this queued run could be dispatched; create a fresh run",
    );
    expect(mockDb.researchRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", errorCode: "RESEARCH_POLICY_CHANGED" }),
    }));
    expect(mockDb.researchRun.update).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a provider removed from policy while the run was queued", async () => {
    mockDb.researchRun.findUnique.mockResolvedValue({ ...run, policyRevision: 4,
      site: { ...run.site, researchPolicy: { ...run.site.researchPolicy, providers: ["news"] } } });
    await expect(runResearchRun("run-1")).rejects.toThrow(
      "A queued provider is outside the current site policy: reddit",
    );
    expect(mockDb.researchRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", errorCode: "RESEARCH_PROVIDER_NOT_ALLOWED" }),
    }));
    expect(mockDb.researchRun.update).toHaveBeenCalledTimes(1);
  });
});
