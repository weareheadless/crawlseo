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

describe("CMP-009 the outcome stage", () => {
  function outcomeDb(over: { enableResearch?: boolean } = {}) {
    const base = db() as never as Record<string, unknown> & {
      site: { findMany: ReturnType<typeof vi.fn> };
    };
    base.site.findMany = vi.fn(async () => [
      {
        id: "s1",
        domain: "new.example",
        projectId: "p1",
        userId: "u1",
        siteProfile: { topics: ["Fitted wardrobes"], audience: null },
        researchPolicy: { enabled: over.enableResearch ?? true },
      },
    ]);
    // The sweep reads its own tables; a project with no delivered work reports zeros.
    (base as Record<string, unknown>).task = { findMany: vi.fn(async () => []) };
    (base as Record<string, unknown>).outcomeObservation = {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
    };
    (base as Record<string, unknown>).evidenceRecord = { findMany: vi.fn(async () => []) };
    return base;
  }

  it("reports the sweep as a stage, with its counts", async () => {
    const results = await runMonthlyCycle(outcomeDb() as never, { now: new Date("2026-11-04T00:00:00.000Z") });
    const stage = results[0].stages.find((entry) => entry.stage === "outcome");
    expect(stage).toBeTruthy();
    // No delivered work yet, so nothing to measure — and the stage says so rather than
    // reporting a bare zero.
    expect(stage?.detail).toContain("0 measured");
    expect(stage?.detail).toContain("0 unbaselined");
  });

  it("runs even when research is switched off, because it asks a different question", async () => {
    // Whether the work we shipped did anything is not the same decision as whether to
    // research more. Gating the outcome sweep on the research switch would leave a site
    // that turned research off permanently unmeasured.
    const results = await runMonthlyCycle(outcomeDb({ enableResearch: false }) as never, {
      now: new Date("2026-11-04T00:00:00.000Z"),
    });
    const research = results[0].stages.find((entry) => entry.stage === "research");
    const outcome = results[0].stages.find((entry) => entry.stage === "outcome");
    expect(research?.status).toBe("skipped");
    expect(research?.detail).toContain("research disabled");
    expect(outcome).toBeTruthy();
    expect(outcome?.status).not.toBe("failed");
    expect(outcome?.detail).toContain("measured");
  });

  it("does not sweep on a dry run", async () => {
    const database = outcomeDb();
    await runMonthlyCycle(database as never, { dryRun: true, now: new Date("2026-11-04T00:00:00.000Z") });
    expect((database as Record<string, { findMany: ReturnType<typeof vi.fn> }>).task.findMany).not.toHaveBeenCalled();
    const stage = (await runMonthlyCycle(database as never, { dryRun: true, now: new Date("2026-11-04T00:00:00.000Z") }))[0].stages.find(
      (entry) => entry.stage === "outcome"
    );
    expect(stage?.detail).toContain("would sweep");
  });
});
