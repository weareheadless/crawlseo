import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  topics: [] as string[],
  ensure: vi.fn(),
  enqueue: vi.fn(),
  createRun: vi.fn(),
}));

vi.mock("@/lib/tenants/analysis", () => ({
  ensureTenantAnalysis: store.ensure,
}));
vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: store.enqueue }));
vi.mock("@/lib/research/service", () => ({ createResearchRun: store.createRun }));
vi.mock("@/lib/site/context", () => ({
  resolveSiteContext: vi.fn(async () => ({ language: "en", market: null })),
}));
vi.mock("@/lib/research/topic-map", () => ({
  topicMapKey: (siteId: string, month: string) => `topic-map:${siteId}:${month}`,
}));
vi.mock("@/lib/research/topic-map-run", () => ({
  runTopicMap: vi.fn(async () => ({ status: "completed", runId: "tm-1", map: { clusters: [] }, taxonomy: { topics: [] } })),
}));
vi.mock("@/lib/research/weekly-refresh", () => ({
  runWeeklyRefresh: vi.fn(async () => ({ status: "completed", week: "2026-W45", news: { stored: 0 }, timely: { stored: 0, proposals: [] } })),
}));

import { runSiteCycle } from "@/lib/jobs/site-cycle";
import { runTopicMap } from "@/lib/research/topic-map-run";

function db() {
  return {
    site: {
      findMany: vi.fn(async () => [
        {
          id: "s1",
          domain: "new.example",
          projectId: "p1",
          userId: "u1",
          siteProfile: { topics: [], audience: null },
          researchPolicy: { enabled: true, cadence: "weekly" },
        },
      ]),
    },
    job: { findUnique: vi.fn(async () => null) },
    crawl: { create: vi.fn(async () => ({ id: "crawl-1" })), findFirst: vi.fn(async () => ({ id: "crawl-1" })) },
    evidenceRecord: { count: vi.fn(async () => 12) },
    researchRun: { findFirst: vi.fn(async () => null) },
    businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
    siteProfile: {
      findUnique: vi.fn(async () => ({ topics: store.topics, audience: null })),
    },
  };
}

beforeEach(() => {
  store.topics = [];
  store.ensure.mockReset();
  store.enqueue.mockReset();
  store.createRun.mockReset();
  store.ensure.mockImplementation(async () => {
    store.topics = ["Fitted wardrobes"];
    return { siteId: "s1", domain: "new.example", projectId: "p1", ready: false, steps: [] };
  });
  store.createRun.mockResolvedValue({ id: "run-1", status: "PENDING" });
  store.enqueue.mockResolvedValue({});
});

describe("site cycle bootstrap", () => {
  it("bootstraps a new tenant before deciding research has no topics", async () => {
    const results = await runSiteCycle(db() as never, { now: new Date("2026-11-04T00:00:00.000Z") });
    expect(store.ensure).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      expect.objectContaining({ apply: true, bootstrapOnly: true, skipResearch: true })
    );
    expect(store.createRun).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ topics: ["Fitted wardrobes"] }),
      "u1",
      expect.any(String)
    );
    expect(results[0].stages.find((stage) => stage.stage === "research")?.status).toBe("queued");
  });

  it("does not bootstrap during a dry run", async () => {
    await runSiteCycle(db() as never, { dryRun: true, now: new Date("2026-11-04T00:00:00.000Z") });
    expect(store.ensure).not.toHaveBeenCalled();
  });
});

function dbFor(site: Record<string, unknown>, monthResearch: { id: string; status: string } | null = null) {
  return {
    site: { findMany: vi.fn(async () => [site]) },
    job: { findUnique: vi.fn(async () => null) },
    crawl: { create: vi.fn(async () => ({ id: "crawl-1" })), findFirst: vi.fn(async () => ({ id: "crawl-1" })) },
    evidenceRecord: { count: vi.fn(async () => 12) },
    researchRun: {
      // The bundle's existence check asks by idempotency key; the dependency
      // checks ask by schedule or by month window.
      findFirst: vi.fn(async (args?: { where?: { idempotencyKey?: unknown } }) =>
        args?.where?.idempotencyKey ? null : monthResearch
      ),
      update: vi.fn(async () => ({})),
    },
    siteProfile: { findUnique: vi.fn(async () => ({ topics: store.topics, audience: null })) },
    businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
  };
}

const activeSite = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  domain: "new.example",
  projectId: "p1",
  userId: "u1",
  siteProfile: { topics: [], audience: null },
  researchPolicy: { enabled: true, cadence: "weekly" },
  project: { researchBudgetTimeZone: "UTC" },
  ...over,
});

describe("site cycle dependency order", () => {
  it("blocks research and the bundle when knowledge cannot be established", async () => {
    store.ensure.mockResolvedValue({
      steps: [{ step: "business-knowledge", status: "failed", detail: "no page could be read" }],
    });
    const results = await runSiteCycle(dbFor(activeSite()) as never, { now: new Date("2026-11-04T00:00:00.000Z") });
    const stages = results[0].stages;
    expect(stages.find((stage) => stage.stage === "research")?.status).toBe("blocked");
    expect(stages.find((stage) => stage.stage === "bundle")?.status).toBe("blocked");
    expect(store.createRun).not.toHaveBeenCalled();
  });

  it("queues the bundle only once the month's research run has finished", async () => {
    store.ensure.mockResolvedValue({ steps: [{ step: "business-knowledge", status: "ok", detail: "existing" }] });
    const results = await runSiteCycle(
      dbFor(activeSite(), { id: "run-1", status: "COMPLETED" }) as never,
      { now: new Date("2026-11-04T00:00:00.000Z") }
    );
    const bundle = results[0].stages.find((stage) => stage.stage === "bundle");
    expect(bundle?.status).toBe("queued");
    expect(store.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: "BUNDLE" }));
    // The taxonomy is refreshed and approved automatically, before the bundle is
    // queued, and says so on the run.
    expect(runTopicMap).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      approval: expect.stringMatching(/^auto:site-cycle:/),
      mode: "execute",
      refreshJobMap: true,
    }));
  });

  it("runs the bundle from first-party demand when research is disabled", async () => {
    store.ensure.mockResolvedValue({ steps: [{ step: "business-knowledge", status: "ok", detail: "existing" }] });
    const site = activeSite({ researchPolicy: { enabled: false, cadence: "weekly" } });
    const results = await runSiteCycle(dbFor(site) as never, { now: new Date("2026-11-04T00:00:00.000Z") });
    const stages = results[0].stages;
    expect(stages.find((stage) => stage.stage === "research")?.status).toBe("skipped");
    expect(stages.find((stage) => stage.stage === "research")?.detail).toContain("disabled");
    expect(stages.find((stage) => stage.stage === "bundle")?.status).toBe("queued");
  });
});

describe("failed research retry", () => {
  it("retries a failed scheduled run once instead of ending research for the window", async () => {
    store.ensure.mockResolvedValue({ steps: [{ step: "business-knowledge", status: "ok", detail: "existing" }] });
    const database = dbFor(activeSite(), { id: "run-failed", status: "FAILED" });
    const results = await runSiteCycle(database as never, { now: new Date("2026-11-04T00:00:00.000Z") });

    const research = results[0].stages.find((stage) => stage.stage === "research");
    expect(research?.status).toBe("queued");
    expect(research?.detail).toContain("retrying failed run run-failed");
    expect(store.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: "RESEARCH_RUN",
      idempotencyKey: "research-run:run-failed:retry",
      payload: { researchRunId: "run-failed" },
    }));
  });
});
