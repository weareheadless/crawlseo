import { describe, expect, it, vi } from "vitest";

import { bridgeFindingsToEvidence, findingDimensions } from "@/lib/research/finding-evidence";
import { runDetectors } from "@/lib/funnel/detectors";

const AT = new Date("2026-11-02T00:00:00.000Z");

const finding = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "f1",
  runId: "run-1",
  type: "PAIN_POINT",
  theme: "pricing",
  summary: "Owners fear long contracts",
  confidence: 70,
  sentiment: "negative",
  urgency: "high",
  createdAt: AT,
  ...over,
});

function fakeDb(findings: Array<Record<string, unknown>>) {
  const evidence: Array<Record<string, unknown>> = [];
  const db = {
    researchFinding: { findMany: vi.fn(async () => findings) },
    evidenceRecord: {
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        const row = { id: `ev-${evidence.length + 1}`, ...args.create };
        evidence.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async (args?: { where?: { kind?: unknown } }) => {
        const kind = args?.where?.kind;
        if (!kind) return evidence;
        const kinds = typeof kind === "string" ? [kind] : (kind as { in?: string[] }).in ?? [];
        return evidence.filter((row) => kinds.includes(row.kind as string));
      }),
    },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue([]) },
    opportunity: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "op-1", status: "detected", ...args.data })),
      update: vi.fn(async () => ({})),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    evidenceEdge: { upsert: vi.fn(async () => ({ id: "edge" })), findMany: vi.fn().mockResolvedValue([]), count: vi.fn() },
    rawProviderResponse: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return { db: db as never, evidence };
}

describe("business research → funnel evidence bridge", () => {
  it("writes one research_finding observation per finding, timestamped by the finding", async () => {
    const { db, evidence } = fakeDb([finding(), finding({ id: "f2", type: "COMPETITOR", summary: "Rivals sell retainers" })]);
    const result = await bridgeFindingsToEvidence(db, { projectId: "p1", siteId: "s1", runId: "run-1" });
    expect(result.findings).toBe(2);
    expect(result.stored).toBe(2);
    expect(evidence[0]).toMatchObject({ kind: "research_finding", projectId: "p1", siteId: "s1", producer: "research-runner" });
    expect(evidence[0].observedAt).toEqual(AT);
  });

  it("declares confidence with a unit rather than a bare number", async () => {
    const { db, evidence } = fakeDb([finding()]);
    await bridgeFindingsToEvidence(db, { projectId: "p1", runId: "run-1" });
    const metrics = evidence[0].metrics as Record<string, { value: number; unit: string; source: string }>;
    expect(metrics["first_party:confidence"]).toEqual({ value: 70, unit: "score", source: "first_party" });
  });

  it("flags only winnable gaps, so context does not become work", () => {
    expect(findingDimensions(finding({ type: "PAIN_POINT" }) as never).painPoint).toBe("true");
    expect(findingDimensions(finding({ type: "COMPETITOR" }) as never).positioningGap).toBe("true");
    const context = findingDimensions(finding({ type: "GENERAL" }) as never);
    expect(context.painPoint).toBeNull();
    expect(context.positioningGap).toBeNull();
  });

  it("counts actionable findings separately from context", async () => {
    const { db } = fakeDb([
      finding({ id: "f1", type: "PAIN_POINT" }),
      finding({ id: "f2", type: "COMPETITOR" }),
      finding({ id: "f3", type: "GENERAL", summary: "Background" }),
    ]);
    const result = await bridgeFindingsToEvidence(db, { projectId: "p1", runId: "run-1" });
    expect(result.findings).toBe(3);
    expect(result.actionable).toBe(2);
  });

  it("makes bridged findings reach the opportunity board as O13", async () => {
    const { db } = fakeDb([finding({ type: "PAIN_POINT", summary: "Owners fear long contracts" })]);
    await bridgeFindingsToEvidence(db, { projectId: "p1", runId: "run-1" });
    const run = await runDetectors(db, "p1", { now: AT });
    expect(run.created).toBeGreaterThanOrEqual(1);
    const created = (db as unknown as { opportunity: { create: ReturnType<typeof vi.fn> } }).opportunity.create.mock.calls.map(
      (call: Array<{ data: { type: string } }>) => call[0].data.type
    );
    expect(created).toContain("O13_user_pain_point");
  });

  it("handles a run with no findings without writing anything", async () => {
    const { db, evidence } = fakeDb([]);
    const result = await bridgeFindingsToEvidence(db, { projectId: "p1", runId: "run-1" });
    expect(result).toEqual({ findings: 0, stored: 0, actionable: 0 });
    expect(evidence).toHaveLength(0);
  });
});
