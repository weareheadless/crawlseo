import { describe, expect, it, vi } from "vitest";

import { bridgeSeoResearchRunToEvidence, taskToEvidence } from "@/lib/dataforseo/seo-research-evidence";

const AT = new Date("2026-11-02T00:00:00.000Z");

const task = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  kind: "DOMAIN_OVERVIEW",
  providerTaskId: "prov-1",
  costMicros: 1500,
  result: { organicKeywords: 1200, organicTraffic: 8000, organicCost: 420.5, backlinks: 300, referringDomains: 40 },
  completedAt: AT,
  input: {},
  ...over,
});

function fakeDb(tasks: Array<Record<string, unknown>>) {
  const raws: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const db = {
    seoResearchTask: { findMany: vi.fn(async () => tasks) },
    rawProviderResponse: {
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        const id = (args.create as { providerTaskId: string }).providerTaskId;
        const existing = raws.find((row) => row.providerTaskId === id);
        if (existing) return { id: existing.id };
        const row = { id: `raw-${raws.length + 1}`, ...args.create };
        raws.push(row);
        return { id: row.id };
      }),
      findUnique: vi.fn(async () => ({ costMicros: BigInt(1500), status: "succeeded" })),
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

describe("stored SEO research → funnel evidence", () => {
  it("maps a domain overview to analytics with declared units", () => {
    const mapped = taskToEvidence(task() as never);
    expect(mapped.kind).toBe("analytics");
    expect(mapped.metrics["provider:organicTraffic"]).toEqual({ value: 8000, unit: "visits/month", source: "provider" });
    expect(mapped.metrics["provider:organicCost"]).toEqual({ value: 420.5, unit: "currency", source: "provider" });
    expect(mapped.dimensions).toEqual({ scope: "domain_overview" });
  });

  it("maps a backlinks overview to backlink_profile", () => {
    const mapped = taskToEvidence(
      task({ kind: "BACKLINKS_OVERVIEW", result: { totalBacklinks: 300, referringDomains: 40, referringIps: 30, dofollow: 200, nofollow: 100 } }) as never
    );
    expect(mapped.kind).toBe("backlink_profile");
    expect(mapped.metrics["provider:referringDomains"]).toEqual({ value: 40, unit: "count", source: "provider" });
  });

  it("maps a keyword seed to keyword_metrics and reports the row count", () => {
    const mapped = taskToEvidence(task({ kind: "KEYWORD_SEED", result: [{ keyword: "a", volume: 10 }, { keyword: "b", volume: 5 }] }) as never);
    expect(mapped.kind).toBe("keyword_metrics");
    expect(mapped.dimensions).toEqual({ rowCount: 2 });
  });

  it("refuses to map an empty or unmapped task, with a reason", () => {
    expect(taskToEvidence(task({ kind: "KEYWORD_SEED", result: [] }) as never).reason).toBe("empty keyword list");
    expect(taskToEvidence(task({ kind: "SOMETHING_NEW", result: {} }) as never).reason).toMatch(/unmapped task kind/);
    expect(taskToEvidence(task({ result: null }) as never).reason).toBe("no stored result");
  });

  it("stores the raw payload first, then evidence pointing at it", async () => {
    const { db, raws, evidence } = fakeDb([task()]);
    const result = await bridgeSeoResearchRunToEvidence(db, { projectId: "p1", siteId: "s1", researchRunId: "run-1" });
    expect(result.stored).toBe(1);
    expect(raws[0]).toMatchObject({ product: "domain_analytics", providerTaskId: "prov-1" });
    expect(raws[0].costMicros).toBe(BigInt(1500));
    expect(evidence[0].rawResponseId).toBe("raw-1");
    expect(result.kinds).toEqual({ analytics: 1 });
  });

  it("projects every keyword row of a seed, not only a summary", async () => {
    const { db, evidence } = fakeDb([
      task({ kind: "KEYWORD_SEED", result: [{ keyword: "abat jour", volume: 2400 }, { keyword: "lampe", volume: 900 }] }),
    ]);
    await bridgeSeoResearchRunToEvidence(db, { projectId: "p1", researchRunId: "run-1" });
    const keywordRows = evidence.filter((row) => row.kind === "keyword_metrics");
    // one summary + two rows
    expect(keywordRows).toHaveLength(3);
    expect(keywordRows.slice(1).map((row) => (row.dimensions as { query: string }).query)).toEqual(["abat jour", "lampe"]);
  });

  it("skips a task with no recorded cost and says why", async () => {
    const { db, raws } = fakeDb([task({ costMicros: null })]);
    const result = await bridgeSeoResearchRunToEvidence(db, { projectId: "p1", researchRunId: "run-1" });
    expect(result.stored).toBe(0);
    expect(result.skipped).toEqual([{ taskId: "t1", reason: "no recorded cost" }]);
    expect(raws).toHaveLength(0);
  });

  it("is idempotent: replaying a run adds no evidence", async () => {
    const { db, evidence } = fakeDb([task()]);
    await bridgeSeoResearchRunToEvidence(db, { projectId: "p1", researchRunId: "run-1" });
    const after = evidence.length;
    await bridgeSeoResearchRunToEvidence(db, { projectId: "p1", researchRunId: "run-1" });
    expect(evidence.length).toBe(after);
  });

  it("handles a run with no completed tasks", async () => {
    const { db } = fakeDb([]);
    const result = await bridgeSeoResearchRunToEvidence(db, { projectId: "p1", researchRunId: "run-1" });
    expect(result).toEqual({ tasks: 0, stored: 0, skipped: [], kinds: {} });
  });
});
