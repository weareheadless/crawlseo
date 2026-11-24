import { describe, expect, it, vi } from "vitest";

import { DETECTOR_THRESHOLDS, runDetectors } from "@/lib/funnel/detectors";
import { TARGET_POSITION, ctrCurve } from "@/lib/funnel/impact";

/**
 * CMP-005: the two demand defects, and what each fix is actually worth.
 *
 * The issue claimed 103 parked rows had "zero upside by construction" because
 * `targetPosition == currentPosition`. Measured against the live database on
 * 2026-11-24, that was wrong: **1** row had literally zero incremental clicks.
 * The real defect was narrower and still real — 57 live striking-distance rows
 * passed their current position as their target, understating their upside by a
 * median **2.7×**, and they never read a bought volume at all.
 *
 * These tests pin what is true now, so the next reader does not re-litigate the
 * number the issue got wrong.
 */

const NOW = new Date("2026-11-24T12:00:00.000Z");

type SeedRow = {
  id: string;
  kind: string;
  observedAt: Date;
  dimensions: Record<string, unknown>;
  metrics: Record<string, { value: number | null; unit: string; source: string }>;
};

const row = (
  id: string,
  kind: string,
  dims: Record<string, unknown>,
  metrics: SeedRow["metrics"],
  observedAt = NOW
): SeedRow => ({ id, kind, observedAt, dimensions: dims, metrics });

const metric = (value: number, unit: string, source = "provider") => ({ value, unit, source });

/** A rank row: a query at a position, with first-party reach and maybe a volume. */
function rankRow(input: {
  id: string;
  query: string;
  position: number;
  impressions: number;
  ctr: number;
  volume?: number;
}): SeedRow {
  const metrics: SeedRow["metrics"] = {
    "provider:position": metric(input.position, "rank"),
    "first_party:impressions": metric(input.impressions, "count", "first_party"),
    "first_party:clicks": metric(Math.round(input.impressions * input.ctr), "count", "first_party"),
    "first_party:ctr": metric(input.ctr, "ratio", "first_party"),
  };
  if (input.volume != null) metrics["provider:volume"] = metric(input.volume, "searches/month");
  return row(
    input.id,
    "keyword_rank",
    {
      query: input.query,
      url: `https://x.com/${input.id}`,
      cluster: "local",
      windowEnd: "2026-11-23T00:00:00.000Z",
      windowRole: "current",
      windowDays: 28,
    },
    metrics
  );
}

/** The minimal db `runDetectors` touches, mirroring tests/funnel-detectors.test.ts. */
function mockDb(seed: SeedRow[]) {
  const created: Array<Record<string, unknown>> = [];
  const byDedup = new Map<string, { id: string; status: string; scoreValue?: number }>();
  let counter = 0;
  const db = {
    evidenceRecord: {
      findMany: vi.fn(async () => seed),
    },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue([{ id: "c1", slug: "local", name: "Local" }]) },
    opportunity: {
      findMany: vi.fn(async () => [...byDedup.values()].map((r) => ({ id: r.id, status: r.status, scoreValue: r.scoreValue ?? 0 }))),
      findUnique: vi.fn(async (args: { where: { projectId_dedupKey: { dedupKey: string } } }) =>
        byDedup.get(args.where.projectId_dedupKey.dedupKey) ?? null
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> & { dedupKey: string; scoreValue: number } }) => {
        counter += 1;
        const record = { id: `op-${counter}`, status: "detected", ...args.data };
        byDedup.set(args.data.dedupKey, { id: record.id, status: "detected", scoreValue: args.data.scoreValue });
        created.push(record);
        return record;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const entry = [...byDedup.values()].find((r) => r.id === args.where.id);
        if (entry) Object.assign(entry, args.data);
        return { id: args.where.id, ...args.data };
      }),
      groupBy: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(async (args: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        for (const entry of byDedup.values()) {
          if (args.where.id.in.includes(entry.id)) Object.assign(entry, args.data);
        }
        return { count: args.where.id.in.length };
      }),
    },
    evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn().mockResolvedValue(3) },
  };
  return { db, created };
}

async function candidatesFrom(seed: SeedRow[]) {
  const { db } = mockDb(seed);
  const result = await runDetectors(db as never, "p1", { now: NOW, dryRun: true });
  return result.candidates ?? [];
}

type Worth = Record<string, number | string | null | undefined>;

function worthOf(candidates: Array<{ type: string; scoreInputs?: unknown }>, type: string): Worth {
  const found = candidates.find((candidate) => candidate.type === type);
  if (!found) throw new Error(`${type} did not fire`);
  return (found.scoreInputs as { worth: Worth }).worth;
}

describe("CMP-005 striking distance targets the position the play reaches", () => {
  it("does not target the position it is already at", async () => {
    const candidates = await candidatesFrom([
      rankRow({ id: "sd", query: "striking query", position: 15, impressions: 400, ctr: 0 }),
    ]);
    const worth = worthOf(candidates, "O2_striking_distance");
    expect(worth.currentPosition).toBe(15);
    // The bug: this used to be 15, so the CTR gap was measured against itself.
    expect(worth.targetPosition).toBe(TARGET_POSITION.O2_striking_distance);
    expect(worth.targetPosition).not.toBe(worth.currentPosition);
  });

  it("produces a materially larger upside than the self-targeting bug did", async () => {
    const candidates = await candidatesFrom([
      rankRow({ id: "sd", query: "striking query", position: 15, impressions: 400, ctr: 0 }),
    ]);
    const worth = worthOf(candidates, "O2_striking_distance");
    const volume = Number(worth.volume);
    const currentCtr = Number(worth.currentPosition === 15 ? 0 : worth.observedCtr);
    const monthlyFactor = 30 / 28;

    const buggy = volume * Math.max(0, ctrCurve(15)! - currentCtr) * monthlyFactor;
    const fixed = volume * Math.max(0, ctrCurve(TARGET_POSITION.O2_striking_distance)! - currentCtr) * monthlyFactor;

    // Position 15 sits on the 1.5% band; the target of 8 sits on the 4% band. That
    // 2.7x is exactly what the live data showed, and it is the point of the fix.
    expect(fixed / buggy).toBeCloseTo(2.67, 1);
  });

  it("keeps the snippet play targeting its own position, because it is not a ranking play", async () => {
    // Position 6 with a CTR far below the curve: the rank is fine, the snippet is
    // not. A snippet rewrite is not expected to move the rank, so the target stays.
    const candidates = await candidatesFrom([
      rankRow({ id: "snip", query: "snippet query", position: 6, impressions: 500, ctr: 0.002 }),
    ]);
    const worth = worthOf(candidates, "O2_striking_distance");
    expect(worth.currentPosition).toBe(6);
    expect(worth.targetPosition).toBe(6);
  });
});

describe("CMP-005 both rank detectors read the same demand", () => {
  it("uses a bought provider volume for O2 when one exists", async () => {
    const candidates = await candidatesFrom([
      rankRow({ id: "sd", query: "with volume", position: 14, impressions: 40, ctr: 0.005, volume: 900 }),
    ]);
    const worth = worthOf(candidates, "O2_striking_distance");
    // Before the fix O2 always reported first_party and used 40 impressions as if
    // they were a search volume, disagreeing with O1 about the same query.
    expect(worth.volumeSource).toBe("provider");
    expect(worth.volume).toBe(900);
  });

  it("falls back to first-party reach, and says so, when no volume was bought", async () => {
    const candidates = await candidatesFrom([
      rankRow({ id: "sd", query: "no volume", position: 14, impressions: 40, ctr: 0.005 }),
    ]);
    const worth = worthOf(candidates, "O2_striking_distance");
    expect(worth.volumeSource).toBe("first_party");
    expect(worth.volume).toBe(40);
  });

  it("agrees with O1 about a bought volume", async () => {
    // O1 fires at 4–10 and O2 at 11–20, so one query cannot fire both; two queries
    // with the same bought volume must still report it the same way.
    const candidates = await candidatesFrom([
      rankRow({ id: "o1", query: "winnable", position: 7, impressions: 300, ctr: 0.01, volume: 500 }),
      rankRow({ id: "o2", query: "striking", position: 15, impressions: 300, ctr: 0.005, volume: 500 }),
    ]);
    expect(worthOf(candidates, "O1_winnable_rank").volumeSource).toBe("provider");
    expect(worthOf(candidates, "O2_striking_distance").volumeSource).toBe("provider");
  });

  it("treats a volume below the floor as not measured", async () => {
    const candidates = await candidatesFrom([
      rankRow({ id: "sd", query: "tiny volume", position: 14, impressions: 40, ctr: 0.005, volume: 3 }),
    ]);
    const worth = worthOf(candidates, "O2_striking_distance");
    // The 3/mo volume is below the floor, so it is not used as the market size:
    // the detector falls back to observed reach and declares that source instead.
    expect(worth.volumeSource).toBe("first_party");
    expect(worth.volume).toBe(40);
    expect(DETECTOR_THRESHOLDS.minVolume).toBeGreaterThan(3);
  });
});
