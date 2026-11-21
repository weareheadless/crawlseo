import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadJobMap: vi.fn(),
  proposeJobMap: vi.fn(),
  saveJobMap: vi.fn(),
  loadTopicMapData: vi.fn(),
  buildTopicMap: vi.fn(),
  storeTopicMap: vi.fn(),
  synthesizeTopicMap: vi.fn(),
  saveTopicTaxonomy: vi.fn(),
  recordTaxonomyApproval: vi.fn(),
}));

vi.mock("@/lib/research/job-map", () => ({
  loadJobMap: mocks.loadJobMap,
  proposeJobMap: mocks.proposeJobMap,
  saveJobMap: mocks.saveJobMap,
}));
vi.mock("@/lib/research/topic-map", () => ({
  loadTopicMapData: mocks.loadTopicMapData,
  buildTopicMap: mocks.buildTopicMap,
  storeTopicMap: mocks.storeTopicMap,
  synthesizeTopicMap: mocks.synthesizeTopicMap,
  topicMapChecksum: () => "checksum",
  topicMapKey: (siteId: string, month: string) => `topic-map:${siteId}:${month}`,
}));
vi.mock("@/lib/research/topic-taxonomy", () => ({
  projectTopicTaxonomy: () => ({ generatedAt: "2026-11-21T10:00:00.000Z", topics: [{ id: "t1" }] }),
  saveTopicTaxonomy: mocks.saveTopicTaxonomy,
}));
vi.mock("@/lib/research/taxonomy-review", () => ({ recordTaxonomyApproval: mocks.recordTaxonomyApproval }));
vi.mock("@/lib/site/context", () => ({ providerCountry: () => "FR", resolveSiteContext: vi.fn() }));

import { runTopicMap } from "@/lib/research/topic-map-run";

const jobMap = {
  proposedBy: "ai",
  model: "test-model",
  generatedAt: "2026-11-21T10:00:00.000Z",
  jobs: [],
  verdicts: [],
  counts: { sent: 0, assigned: 0, judged: 0, queries: 0, carried: 0, deferred: 0 },
  pageTypeRules: [],
  excludePaths: [],
  newsQueries: [],
  summary: null,
};

const map = {
  domain: "example.test",
  month: "2026-11",
  clusters: [],
  counts: { queries: 0, clusteredQueries: 0, unmappedQueries: 0, pages: 0, news: 0 },
  ai: { available: false, model: null, error: null },
  business: {},
};

function db() {
  return {
    site: {
      findUnique: vi.fn(async () => ({ id: "s1", domain: "example.test", projectId: "p1", retiredAt: null })),
    },
    researchRun: {
      findFirst: vi.fn(async (): Promise<{ id: string; status: string; report?: unknown } | null> => null),
      create: vi.fn(async () => ({ id: "run-1" })),
      update: vi.fn(async () => ({ id: "run-1" })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadJobMap.mockResolvedValue(jobMap);
  mocks.proposeJobMap.mockResolvedValue({ jobMap, rejected: [], unassigned: [], error: null, model: "test-model" });
  mocks.loadTopicMapData.mockResolvedValue({
    context: { language: "fr", market: "France", audienceMarket: null, audienceCountry: "FR", audienceCountries: [], audienceLanguages: [], audience: null },
    fields: {},
    marketScope: { offers: [] },
    pages: [],
    queries: [],
  });
  mocks.buildTopicMap.mockReturnValue(map);
  mocks.storeTopicMap.mockResolvedValue({ created: 0, updated: 0, superseded: 0, memberships: 0 });
  mocks.synthesizeTopicMap.mockResolvedValue({ available: false, model: null, error: "not configured" });
});

describe("automatic topic map", () => {
  it("stores the taxonomy and records an automatic approval with a review marker", async () => {
    const result = await runTopicMap(db() as never, {
      siteId: "s1",
      month: "2026-11",
      mode: "execute",
      approval: "auto:site-cycle:2026-11",
      ai: true,
      refreshJobMap: true,
    });

    expect(result.status).toBe("completed");
    expect(mocks.saveJobMap).toHaveBeenCalled();
    expect(mocks.saveTopicTaxonomy).toHaveBeenCalled();
    expect(mocks.storeTopicMap).toHaveBeenCalled();
    expect(mocks.recordTaxonomyApproval).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      expect.objectContaining({ approvedBy: "auto:site-cycle:2026-11", runId: "run-1" })
    );
  });

  it("marks the run as scheduled, not manual", async () => {
    const database = db();
    await runTopicMap(database as never, {
      siteId: "s1", month: "2026-11", mode: "execute", approval: "auto:site-cycle:2026-11",
    });
    expect(database.researchRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        trigger: "SCHEDULED",
        requestedBy: "site-cycle",
        brief: expect.objectContaining({ approvalReference: "auto:site-cycle:2026-11" }),
      }),
    }));
  });

  it("writes nothing on a dry run", async () => {
    const result = await runTopicMap(db() as never, { siteId: "s1", month: "2026-11", mode: "dry-run" });
    expect(result.status).toBe("planned");
    expect(mocks.storeTopicMap).not.toHaveBeenCalled();
    expect(mocks.saveTopicTaxonomy).not.toHaveBeenCalled();
    expect(mocks.recordTaxonomyApproval).not.toHaveBeenCalled();
  });

  it("reuses a completed map instead of paying for a second one", async () => {
    const database = db();
    database.researchRun.findFirst.mockResolvedValue({ id: "run-existing", status: "COMPLETED", report: { version: 1 } });
    const result = await runTopicMap(database as never, {
      siteId: "s1", month: "2026-11", mode: "execute", approval: "auto:site-cycle:2026-11",
    });
    expect(result.status).toBe("existing");
    expect(mocks.loadJobMap).not.toHaveBeenCalled();
  });
});
