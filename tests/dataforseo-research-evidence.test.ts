import { describe, expect, it, vi } from "vitest";

import { bridgeKeywordRunToEvidence, readKeywordRows, releaseBridgedRunResult, type StoredKeywordRun } from "@/lib/dataforseo/research-evidence";

const AT = new Date("2026-11-02T00:00:00.000Z");

const run = (over: Partial<StoredKeywordRun> = {}): StoredKeywordRun => ({
  id: "run-1",
  siteId: "s1",
  projectId: "p1",
  providerTaskId: "task-1",
  costMicros: 4200,
  result: [
    { keyword: "abat jour", volume: 2400, difficulty: 31, cpc: 0.42, competition: 0.6 },
    { keyword: "abat jour pagode", volume: 320, difficulty: 18, cpc: 0.3, competition: 0.4 },
  ],
  language: "fr",
  country: "FR",
  completedAt: AT,
  requestedAt: new Date("2026-11-01T00:00:00.000Z"),
  ...over,
});

function fakeDb() {
  const raws: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const db = {
    rawProviderResponse: {
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        const existing = raws.find(
          (row) => row.providerTaskId === (args.create as { providerTaskId: string }).providerTaskId
        );
        if (existing) return { id: existing.id };
        const row = { id: `raw-${raws.length + 1}`, ...args.create };
        raws.push(row);
        return { id: row.id };
      }),
      findUnique: vi.fn(async () => ({ costMicros: BigInt(4200), status: "succeeded" })),
    },
    evidenceRecord: {
      upsert: vi.fn(async (args: { where: { projectId_kind_observationHash: { observationHash: string } }; create: Record<string, unknown> }) => {
        const hash = args.where.projectId_kind_observationHash.observationHash;
        const existing = evidence.find((row) => row.observationHash === hash);
        if (existing) return { id: existing.id };
        const row = { id: `ev-${evidence.length + 1}`, ...args.create };
        evidence.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
  };
  return { db: db as never, raws, evidence };
}

describe("stored DataForSEO research → funnel evidence", () => {
  it("reads keyword rows from an array result", () => {
    expect(readKeywordRows(run().result)).toHaveLength(2);
  });

  it("reads keyword rows from a wrapped result", () => {
    expect(readKeywordRows({ items: [{ keyword: "x", volume: 1 }] })).toEqual([
      { keyword: "x", volume: 1, difficulty: null, cpc: null, competition: null },
    ]);
  });

  it("ignores rows without a keyword", () => {
    expect(readKeywordRows([{ volume: 10 }, null, "nope"])).toEqual([]);
  });

  it("stores the raw payload first, then evidence pointing at it", async () => {
    const { db, raws, evidence } = fakeDb();
    const result = await bridgeKeywordRunToEvidence(db, run());
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({ provider: "dataforseo", providerTaskId: "task-1" });
    expect(raws[0].costMicros).toBe(BigInt(4200));
    expect(result.stored).toBe(2);
    expect(evidence.every((row) => row.rawResponseId === "raw-1")).toBe(true);
  });

  it("declares every provider metric with a unit", async () => {
    const { db, evidence } = fakeDb();
    await bridgeKeywordRunToEvidence(db, run());
    const metrics = evidence[0].metrics as Record<string, { value: number; unit: string; source: string }>;
    expect(metrics["provider:volume"]).toEqual({ value: 2400, unit: "searches/month", source: "provider" });
    expect(metrics["provider:difficulty"]).toEqual({ value: 31, unit: "score", source: "provider" });
    expect(metrics["provider:cpc"]).toEqual({ value: 0.42, unit: "currency", source: "provider" });
  });

  it("keeps the run locale as a dimension", async () => {
    const { db, evidence } = fakeDb();
    await bridgeKeywordRunToEvidence(db, run());
    expect((evidence[0].dimensions as { locale: string }).locale).toBe("fr-FR");
  });

  it("is idempotent: replaying the same run adds no evidence", async () => {
    const { db, evidence } = fakeDb();
    await bridgeKeywordRunToEvidence(db, run());
    const afterFirst = evidence.length;
    await bridgeKeywordRunToEvidence(db, run());
    expect(evidence.length).toBe(afterFirst);
  });

  it("refuses to give paid data a cost it does not have", async () => {
    const { db, raws, evidence } = fakeDb();
    const result = await bridgeKeywordRunToEvidence(db, run({ costMicros: null }));
    expect(result.stored).toBe(0);
    expect(result.skipped).toBe(2);
    expect(raws).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it("does nothing for a run with no keyword rows", async () => {
    const { db, raws } = fakeDb();
    const result = await bridgeKeywordRunToEvidence(db, run({ result: { ranked: [] } }));
    expect(result).toEqual({ rows: 0, stored: 0, skipped: 0, rawResponseId: null });
    expect(raws).toHaveLength(0);
  });
});

describe("releasing the duplicated payload", () => {
  const fake = (opts: { raw?: { id: string } | null } = {}) => {
    const updates: Array<Record<string, unknown>> = [];
    return {
      db: {
        rawProviderResponse: { findUnique: vi.fn(async () => opts.raw ?? null) },
        articleKeywordResearchRun: {
          update: vi.fn(async (args: { data: Record<string, unknown> }) => {
            updates.push(args.data);
            return {};
          }),
        },
      } as never,
      updates,
    };
  };

  it("clears the run's result once the raw payload is stored", async () => {
    const { db, updates } = fake({ raw: { id: "raw-1" } });
    const released = await releaseBridgedRunResult(db, { id: "run-1", providerTaskId: "task-1" });
    expect(released).toBe(true);
    expect(updates).toHaveLength(1);
    // Prisma.DbNull is the explicit "set the column to NULL" value.
    expect(Object.keys(updates[0])).toEqual(["result"]);
  });

  it("keeps the result when no raw payload exists, so nothing is lost", async () => {
    const { db, updates } = fake({ raw: null });
    const released = await releaseBridgedRunResult(db, { id: "run-1", providerTaskId: null });
    expect(released).toBe(false);
    expect(updates).toHaveLength(0);
  });
});
