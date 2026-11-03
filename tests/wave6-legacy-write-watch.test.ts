import { describe, expect, it, vi } from "vitest";

import { watchLegacyWrites } from "../scripts/legacy-write-watch";

const NOW = new Date("2026-11-03T06:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function fakeDb(opts: {
  actions?: Array<{ createdAt: Date; owner?: string }>;
  crawls?: Array<{ id: string; finishedAt: Date }>;
  crawlJobs?: Array<{ id: string; updatedAt: Date }>;
}) {
  const rowsIn = (args: { where?: { createdAt?: { gte?: Date } } } | undefined, rows: Array<{ createdAt: Date }>) => {
    const since = args?.where?.createdAt?.gte;
    const scoped = since ? rows.filter((row) => row.createdAt >= since) : rows;
    // Prisma returns newest first because the watcher asks for that order.
    return [...scoped].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  };

  return {
    researchAction: { findMany: vi.fn(async (args?: { where?: { createdAt?: { gte?: Date } } }) => rowsIn(args, opts.actions ?? [])) },
    researchRun: { findMany: vi.fn(async () => []) },
    researchFinding: { findMany: vi.fn(async () => []) },
    seoResearchRun: { findMany: vi.fn(async () => []) },
    seoResearchTask: { findMany: vi.fn(async () => []) },
    articleKeywordResearchRun: { findMany: vi.fn(async () => []) },
    prelaunchResearchRequest: { findMany: vi.fn(async () => []) },
    crawl: {
      findMany: vi.fn(async (args?: { where?: { finishedAt?: { gte?: Date } } }) => {
        const since = args?.where?.finishedAt?.gte;
        return since ? (opts.crawls ?? []).filter((row) => row.finishedAt >= since) : opts.crawls ?? [];
      }),
    },
    job: {
      findMany: vi.fn(async (args?: { where?: { updatedAt?: { gte?: Date } } }) => {
        const since = args?.where?.updatedAt?.gte;
        return since ? (opts.crawlJobs ?? []).filter((row) => row.updatedAt >= since) : opts.crawlJobs ?? [];
      }),
    },
  } as never;
}

describe("legacy write watcher (wave 6 step 2 evidence)", () => {
  it("reports clean when nothing legacy was created and every crawl had a job", async () => {
    const report = await watchLegacyWrites(
      fakeDb({
        crawls: [{ id: "c1", finishedAt: minutesAgo(30) }],
        crawlJobs: [{ id: "j1", updatedAt: minutesAgo(30) }],
      }),
      { hours: 6, now: NOW }
    );
    expect(report.legacyCreates).toEqual([]);
    expect(report.outOfBandCrawls).toBe(0);
    expect(report.clean).toBe(true);
  });

  it("flags legacy rows created in the window, with their owners", async () => {
    const report = await watchLegacyWrites(
      fakeDb({
        actions: [
          { createdAt: minutesAgo(20), owner: "crawl-actions" },
          { createdAt: minutesAgo(10), owner: "crawl-actions" },
        ],
      }),
      { hours: 6, now: NOW }
    );
    expect(report.legacyCreates).toEqual([
      { table: "ResearchAction", created: 2, newest: minutesAgo(10), owners: ["crawl-actions"] },
    ]);
    expect(report.clean).toBe(false);
  });

  it("does not treat a backlogged crawl as out of band when its job was claimed late", async () => {
    // Job queued long ago, claimed now: the finish matches the job activity.
    const report = await watchLegacyWrites(
      fakeDb({
        crawls: [{ id: "c1", finishedAt: minutesAgo(5) }],
        crawlJobs: [{ id: "j1", updatedAt: minutesAgo(4) }],
      }),
      { hours: 6, now: NOW }
    );
    expect(report.outOfBandCrawls).toBe(0);
  });

  it("flags a crawl whose finish has no job activity around it", async () => {
    const report = await watchLegacyWrites(
      fakeDb({
        crawls: [{ id: "c1", finishedAt: minutesAgo(5) }],
        crawlJobs: [{ id: "j1", updatedAt: minutesAgo(200) }],
      }),
      { hours: 6, now: NOW }
    );
    expect(report.outOfBandCrawls).toBe(1);
    expect(report.clean).toBe(false);
  });

  it("scopes the window", async () => {
    const report = await watchLegacyWrites(
      fakeDb({ actions: [{ createdAt: minutesAgo(400), owner: "crawl-actions" }] }),
      { hours: 3, now: NOW }
    );
    expect(report.windowHours).toBe(3);
    expect(report.legacyCreates).toEqual([]);
    expect(report.clean).toBe(true);
  });
});
