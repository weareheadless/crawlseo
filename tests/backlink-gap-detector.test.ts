import { describe, expect, it, vi } from "vitest";

import { runDetectors } from "@/lib/funnel/detectors";

/**
 * CMP-007's detector half.
 *
 * O9 could not fire at all: it filtered on `provider:referringDomainGap` and
 * nothing wrote that metric. Now the metric has a writer, so these tests pin the
 * two things the acceptance asks for:
 *
 *  - at a gap of 3 or more, O9 produces an opportunity **whose summary lists named
 *    domains** (not "competitors have more links"),
 *  - a competitor's referring set does **not** produce its own gap opportunity — it
 *    is one side of the subtraction, not a measurement of the gap.
 */

const NOW = new Date("2026-11-24T12:00:00.000Z");
const THRESHOLD = 3;

type SeedRow = {
  id: string;
  kind: string;
  observedAt: Date;
  dimensions: Record<string, unknown>;
  metrics: Record<string, { value: number | null; unit: string; source: string }>;
};

const metric = (value: number, unit: string, source = "provider") => ({ value, unit, source });

const ownProfile = (gap: number, domains: string[], over: Record<string, unknown> = {}): SeedRow => ({
  id: "own-profile",
  kind: "backlink_profile",
  observedAt: NOW,
  dimensions: { scope: "own_domain", domain: "oursite.com", domains, domainRanks: domains.map((_, index) => 90 - index), ...over },
  metrics: {
    "provider:referringDomainGap": metric(gap, "count"),
    "provider:targetDomainCount": metric(domains.length, "count"),
    "provider:totalBacklinks": metric(85, "count"),
    "provider:referringDomains": metric(63, "count"),
  },
});

function mockDb(seed: SeedRow[]) {
  const created: Array<Record<string, unknown>> = [];
  const byDedup = new Map<string, { id: string; status: string }>();
  let counter = 0;
  const db = {
    evidenceRecord: { findMany: vi.fn(async () => seed) },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue([{ id: "c1", slug: "local", name: "Local" }]) },
    opportunity: {
      findMany: vi.fn(async () => [...byDedup.values()].map((row) => ({ id: row.id, status: row.status, scoreValue: 0 }))),
      findUnique: vi.fn(async (args: { where: { projectId_dedupKey: { dedupKey: string } } }) =>
        byDedup.get(args.where.projectId_dedupKey.dedupKey) ?? null
      ),
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
    evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), count: vi.fn().mockResolvedValue(1) },
  };
  return { db, created };
}

async function o9Candidates(seed: SeedRow[]) {
  const { db } = mockDb(seed);
  const result = await runDetectors(db as never, "p1", { now: NOW, dryRun: true });
  return (result.candidates ?? []).filter((candidate) => candidate.type === "O9_backlink_gap");
}

describe("CMP-007 O9 fires on a measured gap and names the domains", () => {
  it("produces an opportunity at a gap of 3 or more", async () => {
    const candidates = await o9Candidates([
      ownProfile(THRESHOLD, ["linkone.com", "linktwo.com", "linkthree.com"]),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toContain("3 domains");
  });

  it("names the target domains in its summary", async () => {
    const candidates = await o9Candidates([
      ownProfile(5, ["interieurlumiere.com", "luminaires.com", "wecandoo.fr", "fourth.com", "fifth.com"]),
    ]);
    const summary = candidates[0].summary;
    expect(summary).toContain("interieurlumiere.com");
    expect(summary).toContain("luminaires.com");
    expect(summary).toContain("wecandoo.fr");
    // The remainder is counted, not dropped silently.
    expect(summary).toContain("2 more");
    // And not the old vacuous line.
    expect(summary).not.toBe("5 domains link to competitors but not to us.");
  });

  it("carries the provider rank beside a named domain", async () => {
    const candidates = await o9Candidates([ownProfile(3, ["strong.com", "mid.com", "weak.com"])]);
    expect(candidates[0].summary).toContain("authority 90");
  });

  it("does not fire below the threshold", async () => {
    const candidates = await o9Candidates([ownProfile(2, ["a.com", "b.com"])]);
    expect(candidates).toEqual([]);
  });

  it("does not fire on a competitor's own referring set", async () => {
    // A competitor set is one side of the subtraction. If it carried a gap number,
    // O9 would report the competitor's strength as our opportunity.
    const candidate = await o9Candidates([
      {
        id: "competitor-set",
        kind: "backlink_profile",
        observedAt: NOW,
        dimensions: { scope: "competitor_referring_domains", domain: "rival.com", competitor: "rival.com", domains: ["a.com", "b.com", "c.com", "d.com"] },
        metrics: {
          "provider:referringDomains": metric(4, "count"),
          "provider:referringDomainGap": metric(99, "count"),
        },
      },
    ]);
    expect(candidate).toEqual([]);
  });

  it("keeps the how leg pointing at the profile the gap was read from", async () => {
    const { db, created } = mockDb([ownProfile(4, ["a.com", "b.com", "c.com", "d.com"])]);
    await runDetectors(db as never, "p1", { now: NOW });
    const opportunity = created.find((row) => row.type === "O9_backlink_gap");
    expect(opportunity).toBeTruthy();
    expect(opportunity?.status).toBe("detected");
  });

  it("cites the competitor profiles it was computed from, not just our own", async () => {
    // The acceptance: `howEvidenceIds` includes the competitor profile. Citing only
    // the own row would present a subtraction with one visible side.
    const profile = ownProfile(4, ["a.com", "b.com", "c.com", "d.com"], {
      competitorEvidenceIds: ["comp-1", "comp-2", "comp-3"],
    });
    const candidates = await o9Candidates([profile]);
    expect(candidates[0].howEvidenceIds).toContain("own-profile");
    expect(candidates[0].howEvidenceIds).toContain("comp-1");
    expect(candidates[0].howEvidenceIds).toContain("comp-3");
  });

  it("names the gap on the own-domain identity so two runs do not duplicate it", async () => {
    const first = await o9Candidates([ownProfile(4, ["a.com", "b.com", "c.com", "d.com"])]);
    const second = await o9Candidates([ownProfile(4, ["a.com", "b.com", "c.com", "d.com"])]);
    expect(first[0].dedupKey).toBe(second[0].dedupKey);
    expect(first[0].dedupKey).toContain("oursite.com");
  });
});
