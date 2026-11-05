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

import { runMonthlyCycle } from "@/lib/jobs/monthly-cycle";

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
          researchPolicy: { enabled: true },
        },
      ]),
    },
    job: { findUnique: vi.fn(async () => null) },
    crawl: { create: vi.fn(async () => ({ id: "crawl-1" })) },
    researchRun: { findFirst: vi.fn(async () => null) },
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

describe("monthly cycle bootstrap", () => {
  it("bootstraps a new tenant before deciding research has no topics", async () => {
    const results = await runMonthlyCycle(db() as never, { now: new Date("2026-11-04T00:00:00.000Z") });
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
    await runMonthlyCycle(db() as never, { dryRun: true, now: new Date("2026-11-04T00:00:00.000Z") });
    expect(store.ensure).not.toHaveBeenCalled();
  });
});
