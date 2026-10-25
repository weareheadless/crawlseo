import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  researchRun: { findUnique: vi.fn(), count: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  researchPolicy: { findUnique: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  researchFinding: { findMany: vi.fn() },
  saveResearchSources: vi.fn(),
  fetchGoogleNewsRssSearch: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {
  $transaction: mocks.$transaction,
  $queryRaw: mocks.$queryRaw,
  researchPolicy: mocks.researchPolicy,
  researchRun: mocks.researchRun,
  researchFinding: mocks.researchFinding,
  crawl: { findFirst: vi.fn() },
  auditPage: { findMany: vi.fn() },
} }));
vi.mock("@/lib/research/providers/reddit-rss", () => ({ fetchRedditRssSearch: vi.fn() }));
vi.mock("@/lib/research/providers/google-news-rss", () => ({ fetchGoogleNewsRssSearch: mocks.fetchGoogleNewsRssSearch }));
vi.mock("@/lib/research/service", () => ({
  createResearchAction: vi.fn(),
  createResearchFinding: vi.fn(),
  researchMonthBounds: vi.fn(() => ({ start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") })),
  saveResearchSources: mocks.saveResearchSources,
}));
vi.mock("@/lib/agent-tasks/service", () => ({ createAgentTaskForAction: vi.fn() }));
vi.mock("@/lib/research/content", () => ({ generateDraftForAction: vi.fn() }));
vi.mock("@/lib/research/automation", () => ({ autoAgentDecision: vi.fn() }));
vi.mock("@/lib/research/synthesizer", () => ({ synthesizeResearch: vi.fn() }));
vi.mock("@/lib/research/locale", () => ({ researchCountry: vi.fn(() => "US") }));
vi.mock("@/lib/connectors/events", () => ({ emitConnectorEvent: vi.fn() }));

import { runResearchRun } from "@/lib/research/runner";

describe("research provider capability reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.researchRun.findUnique.mockResolvedValue({
      id: "run-web-only", status: "QUEUED", siteId: "site-1", policyRevision: 4,
      providerSet: ["web", "competitor"], recencyDays: 30, topics: ["topic"], brief: { language: "en" },
      site: { id: "site-1", domain: "example.com", projectId: "project-1",
        project: { researchBudgetTimeZone: "UTC" }, connectorBinding: null,
        siteProfile: { constraints: {} },
        researchPolicy: { revision: 4, enabled: true, providers: ["web", "competitor"], monthlyBudget: 9,
          maxSources: 30, recencyDays: 30, autoDraft: false, autoAgent: false } },
      findings: [],
    });
    mocks.researchRun.count.mockResolvedValue(1);
    mocks.researchRun.updateMany.mockResolvedValue({ count: 1 });
    mocks.researchPolicy.findUnique.mockResolvedValue({ enabled: true });
    mocks.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.$queryRaw,
      researchPolicy: mocks.researchPolicy,
      researchRun: mocks.researchRun,
    }));
    mocks.researchFinding.findMany.mockResolvedValue([]);
    mocks.saveResearchSources.mockResolvedValue([]);
    mocks.fetchGoogleNewsRssSearch.mockResolvedValue([]);
  });

  it("reports unimplemented providers without substituting news RSS", async () => {
    await runResearchRun("run-web-only");

    expect(mocks.researchRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "run-web-only" },
      data: expect.objectContaining({
        status: "PARTIAL",
        report: expect.objectContaining({
          providers: [],
          requested_providers: ["web", "competitor"],
          unsupported_providers: ["web", "competitor"],
          source_errors: expect.arrayContaining([
            expect.stringContaining("web: general web search is not implemented"),
            expect.stringContaining("quality: no sources passed"),
          ]),
        }),
      }),
    }));
    expect(mocks.fetchGoogleNewsRssSearch).not.toHaveBeenCalled();
  });
});
