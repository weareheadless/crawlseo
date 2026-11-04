import { describe, expect, it, vi } from "vitest";

import { runDetectors } from "@/lib/funnel/detectors";

/**
 * Two failures from the audit: "cannibalization" fired on two URLs alone and told
 * the owner to consolidate, and "freshness decay" called any position drop stale
 * content without evidence of the cause.
 */
const NOW = new Date("2026-11-02T12:00:00.000Z");
const CURRENT = "2026-10-31T00:00:00.000Z";
const PREVIOUS = "2026-09-30T00:00:00.000Z";

const metric = (value: number, unit: string, source = "first_party") => ({ value, unit, source });

const rank = (
  id: string,
  over: { query: string; url: string; position: number; impressions: number; windowEnd: string }
) => ({
  id,
  kind: "keyword_rank",
  observedAt: new Date(over.windowEnd),
  dimensions: { query: over.query, url: over.url, windowEnd: over.windowEnd, windowRole: over.windowEnd === CURRENT ? "current" : "previous" },
  metrics: {
    "first_party:position": metric(over.position, "rank"),
    "first_party:impressions": metric(over.impressions, "count"),
    "first_party:ctr": metric(0.01, "ratio"),
  },
});

function mockDb(seed: Array<ReturnType<typeof rank>>) {
  const created: Array<Record<string, unknown>> = [];
  const byDedup = new Map<string, { id: string; status: string }>();
  let counter = 0;
  const db = {
    evidenceRecord: { findMany: vi.fn(async () => seed) },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue([]) },
    opportunity: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async (args: { where: { projectId_dedupKey: { dedupKey: string } } }) => byDedup.get(args.where.projectId_dedupKey.dedupKey) ?? null),
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

describe("decline detection", () => {
  it("compares the current window with the previous one", async () => {
    const { db, created } = mockDb([
      rank("p", { query: "seo packages", url: "https://x.com/packages", position: 5, impressions: 300, windowEnd: PREVIOUS }),
      rank("c", { query: "seo packages", url: "https://x.com/packages", position: 11, impressions: 200, windowEnd: CURRENT }),
    ]);
    await runDetectors(db as never, "p1", { now: NOW });
    const o11 = created.find((row) => row.type === "O11_freshness_decay");
    expect(o11).toBeTruthy();
    expect(o11!.summary).toContain("5");
    expect(o11!.summary).toContain("11");
  });

  it("states the movement without claiming the cause", async () => {
    const { db, created } = mockDb([
      rank("p", { query: "seo packages", url: "https://x.com/packages", position: 5, impressions: 300, windowEnd: PREVIOUS }),
      rank("c", { query: "seo packages", url: "https://x.com/packages", position: 11, impressions: 200, windowEnd: CURRENT }),
    ]);
    await runDetectors(db as never, "p1", { now: NOW });
    const summary = String(created.find((row) => row.type === "O11_freshness_decay")!.summary);
    expect(summary).toContain("cause is not established");
    expect(summary).not.toMatch(/stale|refresh the page|outdated/i);
  });

  it("does not fire on one window", async () => {
    const { db, created } = mockDb([
      rank("c", { query: "seo packages", url: "https://x.com/packages", position: 11, impressions: 200, windowEnd: CURRENT }),
    ]);
    await runDetectors(db as never, "p1", { now: NOW });
    expect(created.find((row) => row.type === "O11_freshness_decay")).toBeUndefined();
  });

  it("does not fire on a thin window on either side", async () => {
    const { db, created } = mockDb([
      rank("p", { query: "seo packages", url: "https://x.com/packages", position: 5, impressions: 2, windowEnd: PREVIOUS }),
      rank("c", { query: "seo packages", url: "https://x.com/packages", position: 11, impressions: 200, windowEnd: CURRENT }),
    ]);
    await runDetectors(db as never, "p1", { now: NOW });
    expect(created.find((row) => row.type === "O11_freshness_decay")).toBeUndefined();
  });
});

describe("query overlap", () => {
  it("does not call two URLs cannibalisation without observed overlap", async () => {
    const { db, created } = mockDb([
      rank("a", { query: "pricing", url: "https://x.com/a", position: 9, impressions: 0, windowEnd: CURRENT }),
      rank("b", { query: "pricing", url: "https://x.com/b", position: 12, impressions: 0, windowEnd: CURRENT }),
    ]);
    await runDetectors(db as never, "p1", { now: NOW });
    expect(created.find((row) => row.type === "O10_cannibalization")).toBeUndefined();
  });

  it("asks for a check instead of prescribing consolidation", async () => {
    const { db, created } = mockDb([
      rank("a", { query: "pricing", url: "https://x.com/a", position: 9, impressions: 120, windowEnd: CURRENT }),
      rank("b", { query: "pricing", url: "https://x.com/b", position: 12, impressions: 40, windowEnd: CURRENT }),
    ]);
    await runDetectors(db as never, "p1", { now: NOW });
    const o10 = created.find((row) => row.type === "O10_cannibalization");
    expect(o10).toBeTruthy();
    expect(String(o10!.summary)).toContain("not proof");
    expect(String(o10!.summary)).not.toMatch(/consolidate them|merge them/i);
    // No demand of its own: it stays a hypothesis.
    expect((o10!.scoreInputs as { worth: { volume: unknown } }).worth.volume).toBeNull();
  });
});
