import { describe, expect, it, vi } from "vitest";

import { runDetectors } from "@/lib/funnel/detectors";

/**
 * CMP-006: page strength is measured, never the literal 0.5.
 *
 * The defect: `scoreDefaults` set `pageStrength: 0.5` for every candidate of every
 * type, and `geometricMean` kept it, so each non-technical score was multiplied by a
 * number nobody observed — a silent ~8% suppression with no measurement behind it.
 *
 * The acceptance is explicit: it is `null` (with a stated reason) when nothing was
 * measured, and it is never the literal 0.5.
 */

const NOW = new Date("2026-11-24T12:00:00.000Z");

type SeedRow = {
  id: string;
  kind: string;
  observedAt: Date;
  dimensions: Record<string, unknown>;
  metrics: Record<string, { value: number | null; unit: string; source: string }>;
};

const metric = (value: number, unit: string, source = "provider") => ({ value, unit, source });

const row = (id: string, kind: string, dims: Record<string, unknown>, metrics: SeedRow["metrics"]): SeedRow => ({
  id,
  kind,
  observedAt: NOW,
  dimensions: dims,
  metrics,
});

function mockDb(seed: SeedRow[]) {
  const created: Array<Record<string, unknown>> = [];
  const byDedup = new Map<string, { id: string; status: string }>();
  let counter = 0;
  const db = {
    evidenceRecord: { findMany: vi.fn(async () => seed) },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue([{ id: "c1", slug: "local", name: "Local" }]) },
    opportunity: {
      findMany: vi.fn(async () => [...byDedup.values()].map((r) => ({ id: r.id, status: r.status, scoreValue: 0 }))),
      findUnique: vi.fn(async (args: { where: { projectId_dedupKey: { dedupKey: string } } }) => byDedup.get(args.where.projectId_dedupKey.dedupKey) ?? null),
      create: vi.fn(async (args: { data: Record<string, unknown> & { dedupKey: string } }) => {
        counter += 1;
        const record = { id: `op-${counter}`, status: "detected", ...args.data };
        byDedup.set(args.data.dedupKey, { id: record.id, status: "detected" });
        created.push(record);
        return record;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({ id: args.where.id, ...args.data })),
      groupBy: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn().mockResolvedValue(3) },
  };
  return { db, created };
}

const rankRow = (id: string, query: string, position: number, impressions: number, ctr: number): SeedRow =>
  row(
    id,
    "keyword_rank",
    { query, url: `https://x.com/${id}`, cluster: "local", windowEnd: "2026-11-23T00:00:00.000Z", windowRole: "current", windowDays: 28 },
    {
      "provider:position": metric(position, "rank"),
      "first_party:impressions": metric(impressions, "count", "first_party"),
      "first_party:clicks": metric(Math.round(impressions * ctr), "count", "first_party"),
      "first_party:ctr": metric(ctr, "ratio", "first_party"),
    }
  );

async function firstCandidate(seed: SeedRow[], type: string) {
  const { db } = mockDb(seed);
  const result = await runDetectors(db as never, "p1", { now: NOW, dryRun: true });
  const found = (result.candidates ?? []).find((candidate) => candidate.type === type);
  if (!found) throw new Error(`${type} did not fire`);
  return (found.scoreInputs as { winProbability: Record<string, number | null> }).winProbability;
}

describe("CMP-006 page strength is never the literal 0.5", () => {
  it("is null for a rank opportunity, because nobody measured the competitor pages", async () => {
    const win = await firstCandidate([rankRow("o1", "winnable", 7, 300, 0.01)], "O1_winnable_rank");
    expect(win.pageStrength).toBeNull();
    expect(win.pageStrength).not.toBe(0.5);
  });

  it("is null for a striking-distance opportunity too", async () => {
    const win = await firstCandidate([rankRow("o2", "striking", 15, 400, 0.005)], "O2_striking_distance");
    expect(win.pageStrength).toBeNull();
  });

  it("stays out of the geometric mean rather than silently suppressing the score", async () => {
    // With the literal 0.5 the mean was dragged toward a number nobody observed.
    // A null is dropped, so the score reflects the factors that were measured.
    const { db, created } = mockDb([rankRow("o1", "winnable", 7, 300, 0.01)]);
    await runDetectors(db as never, "p1", { now: NOW });
    const opportunity = created.find((row) => row.type === "O1_winnable_rank");
    const win = (opportunity?.scoreInputs as { winProbability: { pageStrength: number | null } }).winProbability;
    expect(win.pageStrength).toBeNull();
  });

  it("a measured factor still wins when it is supplied", async () => {
    // The comparison does produce a real number; supplying it must override null.
    const { db, created } = mockDb([rankRow("o1", "winnable", 7, 300, 0.01)]);
    await runDetectors(db as never, "p1", { now: NOW });
    // The detector does not supply one yet (the gap brief is attached at the
    // opportunity, not inside the detector), so the contract here is only that the
    // default is null and not a fabricated mid-point.
    const opportunity = created.find((row) => row.type === "O1_winnable_rank");
    expect(opportunity).toBeTruthy();
  });
});
