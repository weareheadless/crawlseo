import { describe, expect, it, vi } from "vitest";

import { runDetectors, selectCurrentPerformanceWindow } from "@/lib/funnel/detectors";

/**
 * A connected site has measured demand from Search Console even when nobody bought
 * keyword volume. Refusing to detect without provider volume left Susi — a site
 * with 986 observed queries in 28 days — with no query-level opportunity at all.
 */
const NOW = new Date("2026-11-02T12:00:00.000Z");

const metric = (value: number, unit: string, source = "first_party") => ({ value, unit, source });

const row = (id: string, kind: string, dimensions: Record<string, unknown>, metrics: Record<string, unknown>, observedAt = NOW) => ({
  id,
  kind,
  observedAt,
  dimensions,
  metrics,
});

function mockDb(seed: Array<ReturnType<typeof row>>) {
  const created: Array<Record<string, unknown>> = [];
  const byDedup = new Map<string, { id: string; status: string }>();
  let counter = 0;
  const db = {
    evidenceRecord: { findMany: vi.fn(async () => seed) },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue([]) },
    opportunity: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async (args: { where: { projectId_dedupKey: { dedupKey: string } } }) =>
        byDedup.get(args.where.projectId_dedupKey.dedupKey) ?? null),
      create: vi.fn(async (args: { data: { dedupKey: string; scoreValue: number } }) => {
        counter += 1;
        const record = { id: `op-${counter}`, status: "detected", ...args.data };
        byDedup.set(args.data.dedupKey, { id: record.id, status: "detected" });
        created.push(record);
        return record;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const entry = [...byDedup.values()].find((r) => r.id === args.where.id);
        if (entry) Object.assign(entry, args.data);
        return { ...entry, ...args.data };
      }),
      groupBy: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn().mockResolvedValue(1) },
  };
  return { db, created };
}

const rankRow = (id: string, over: { impressions: number; clicks: number; position: number; windowEnd: string }) =>
  row(
    id,
    "keyword_rank",
    {
      query: "beachfront homes for sale under $100k",
      url: "https://site.test/beachfront",
      windowDays: 28,
      windowEnd: over.windowEnd,
      scope: "all",
    },
    {
      "first_party:position": metric(over.position, "rank"),
      "first_party:impressions": metric(over.impressions, "count"),
      "first_party:clicks": metric(over.clicks, "count"),
      "first_party:ctr": metric(over.clicks / over.impressions, "ratio"),
    }
  );

describe("winnable rank from first-party demand", () => {
  it("fires on measured impressions when no provider volume exists", async () => {
    const { db, created } = mockDb([rankRow("r1", { impressions: 269, clicks: 10, position: 6.9, windowEnd: "2026-10-31T00:00:00.000Z" })]);
    await runDetectors(db as never, "p1", { now: NOW });
    const o1 = created.find((o) => o.type === "O1_winnable_rank");
    expect(o1).toBeTruthy();
    const worth = (o1!.scoreInputs as { worth: Record<string, unknown> }).worth;
    expect(worth.volumeSource).toBe("first_party");
    expect(worth.volume).toBe(269);
    expect(o1!.summary).toContain("269 impressions");
  });

  it("still refuses a query with too few impressions to act on", async () => {
    const { db, created } = mockDb([rankRow("r1", { impressions: 3, clicks: 0, position: 6, windowEnd: "2026-10-31T00:00:00.000Z" })]);
    await runDetectors(db as never, "p1", { now: NOW });
    expect(created.find((o) => o.type === "O1_winnable_rank")).toBeUndefined();
  });

  it("prefers provider volume and says searches/month when it exists", async () => {
    const rank = rankRow("r1", { impressions: 269, clicks: 10, position: 6, windowEnd: "2026-10-31T00:00:00.000Z" });
    const volume = row("v1", "keyword_metrics", { query: "beachfront homes for sale under $100k" }, { "provider:volume": metric(390, "searches/month", "provider") });
    const { db, created } = mockDb([rank, volume]);
    await runDetectors(db as never, "p1", { now: NOW });
    const o1 = created.find((o) => o.type === "O1_winnable_rank")!;
    const worth = (o1.scoreInputs as { worth: Record<string, unknown> }).worth;
    expect(worth.volumeSource).toBe("provider");
    expect(worth.volume).toBe(390);
    expect(o1.summary).toContain("searches/month");
  });
});

describe("current performance window", () => {
  const older = rankRow("old", { impressions: 900, clicks: 90, position: 5, windowEnd: "2026-09-30T00:00:00.000Z" });
  const current = rankRow("new", { impressions: 100, clicks: 1, position: 9, windowEnd: "2026-10-31T00:00:00.000Z" });

  it("ignores a superseded month so the same query is not counted twice", () => {
    const selected = selectCurrentPerformanceWindow([older, current] as never);
    expect(selected.map((r) => r.id)).toEqual(["new"]);
  });

  it("keeps everything when no row declares a window", () => {
    const legacy = { ...older, dimensions: { query: "q", url: "u" } };
    expect(selectCurrentPerformanceWindow([legacy] as never)).toHaveLength(1);
  });
});

describe("brand and relevance", () => {
  it("does not offer the site's own name as a winnable rank", async () => {
    const brand = rankRow("r1", { impressions: 500, clicks: 50, position: 6, windowEnd: "2026-10-31T00:00:00.000Z" });
    brand.dimensions = { ...brand.dimensions, query: "atelier harmonie" };
    const { db, created } = mockDb([brand]);
    const { brandTermsFromDomain, isBrandQuery } = await import("@/lib/funnel/detectors");
    await runDetectors(db as never, "p1", { now: NOW, brandTerms: brandTermsFromDomain("www.atelier-harmonie.com") });
    expect(created.find((o) => o.type === "O1_winnable_rank")).toBeUndefined();
    expect(isBrandQuery("atelier harmony", ["atelier", "harmonie"])).toBe(true);
    expect(isBrandQuery("restauration fauteuil", ["atelier", "harmonie"])).toBe(false);
  });

  it("keeps a query that shares a word with the offer", async () => {
    const row = rankRow("r1", { impressions: 269, clicks: 10, position: 6, windowEnd: "2026-10-31T00:00:00.000Z" });
    row.dimensions = { ...row.dimensions, query: "condos for sale in puerto morelos" };
    const fact = { id: "k1", kind: "knowledge_fact", observedAt: NOW, dimensions: { field: "services", value: "condos for sale in puerto morelos" }, metrics: {} };
    const { db, created } = mockDb([row, fact]);
    await runDetectors(db as never, "p1", { now: NOW });
    const o1 = created.find((o) => o.type === "O1_winnable_rank")!;
    expect((o1.scoreInputs as { worth: { businessValueSource: string } }).worth.businessValueSource).toBe("knowledge");
  });

  it("marks an off-offer query as unknown relevance instead of claiming it", async () => {
    const row = rankRow("r1", { impressions: 269, clicks: 10, position: 6, windowEnd: "2026-10-31T00:00:00.000Z" });
    row.dimensions = { ...row.dimensions, query: "apartments for rent" };
    const fact = { id: "k1", kind: "knowledge_fact", observedAt: NOW, dimensions: { field: "services", value: "beachfront property sales" }, metrics: {} };
    const { db, created } = mockDb([row, fact]);
    await runDetectors(db as never, "p1", { now: NOW });
    const o1 = created.find((o) => o.type === "O1_winnable_rank")!;
    const worth = (o1.scoreInputs as { worth: { businessValueSource: string; businessValue: number } }).worth;
    expect(worth.businessValueSource).toBe("unknown");
    expect(worth.businessValue).toBe(0.5);
  });
});

describe("snippet opportunity", () => {
  it("flags a top-ten page that earns almost no clicks", async () => {
    const row = rankRow("r1", { impressions: 49, clicks: 0, position: 5.6, windowEnd: "2026-10-31T00:00:00.000Z" });
    row.dimensions = { ...row.dimensions, query: "kit lampe" };
    const { db, created } = mockDb([row]);
    await runDetectors(db as never, "p1", { now: NOW });
    const o2 = created.find((o) => o.type === "O2_striking_distance");
    expect(o2).toBeTruthy();
    expect(String(o2!.title)).toContain("Snippet not earning the click");
  });

  it("does not flag a top-ten page with a healthy CTR", async () => {
    const row = rankRow("r1", { impressions: 49, clicks: 7, position: 5.6, windowEnd: "2026-10-31T00:00:00.000Z" });
    const { db, created } = mockDb([row]);
    await runDetectors(db as never, "p1", { now: NOW });
    expect(created.find((o) => o.type === "O2_striking_distance")).toBeUndefined();
  });
});
