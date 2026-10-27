import { describe, expect, it, vi } from "vitest";
import { importAIVisibilityExport, parseAIVisibilityExport } from "@/lib/research/ai-visibility-import";

const item = {
  question: "best bike shop?",
  answer: { mentions: ["Acme"], recommendations: ["Acme"], citations: ["https://acme.example"] },
};
const valid = {
  version: "ai-visibility-export-v1",
  provider: "perplexity",
  modelSurface: "sonar-web",
  observedAt: "2026-10-27T04:00:00Z",
  questionSetVersion: "questions-v2",
  sourceKind: "provider_export",
  rawExportReference: "operator-upload:export-17.json",
  denominator: 1,
  observations: [item],
};

function mockDb() {
  let rows: any[] = [];
  const model = {
    findFirst: vi.fn(async ({ where }: any) => rows.filter(row => Object.entries(where).every(([key, val]) => row[key]?.toString() === val?.toString())).sort((a, b) => b.version - a.version)[0] ?? null),
    create: vi.fn(async ({ data }: any) => { const row = { id: `row-${rows.length + 1}`, ...data }; rows.push(row); return row; }),
  };
  return { db: { aIVisibilityObservation: model } as any, model, rows: () => rows };
}

describe("explicit AI visibility import", () => {
  it("stores observation and complete source/question-set/denominator provenance without collapsing evidence", async () => {
    const { db, rows } = mockDb();
    const [stored] = await importAIVisibilityExport(db, "project-1", valid);
    expect(stored).toMatchObject({ projectId: "project-1", question: item.question, provider: "perplexity", modelSurface: "sonar-web", questionSetVersion: "questions-v2", sourceKind: "provider_export", rawExportReference: valid.rawExportReference, denominator: 1, version: 1, mentions: ["Acme"], recommendations: ["Acme"], citations: ["https://acme.example"] });
    expect(stored.observedAt).toEqual(new Date(valid.observedAt));
    expect(rows()).toHaveLength(1);
  });

  it("rejects malformed, unversioned, unsupported-provider and missing-question-set exports", () => {
    for (const body of [
      { ...valid, version: undefined },
      { ...valid, questionSetVersion: "" },
      { ...valid, provider: "unsupported" },
      { ...valid, observations: [{ question: "", answer: null }] },
    ]) expect(() => parseAIVisibilityExport(body)).toThrow();
  });

  it("keeps unobserved answers and zero denominators unknown, not zero", async () => {
    const { db } = mockDb();
    const [absent] = await importAIVisibilityExport(db, "p", { ...valid, observations: [{ question: "q", answer: null }] });
    expect(absent.coverage).toEqual({ status: "unknown", reasonCode: "provider_not_observed" });
    const { db: zeroDb } = mockDb();
    const [zero] = await importAIVisibilityExport(zeroDb, "p", { ...valid, denominator: 0 });
    expect(zero.coverage).toEqual({ status: "unknown", reasonCode: "zero_denominator" });
  });

  it("is idempotent for the same export and versions a changed observation", async () => {
    const { db, model, rows } = mockDb();
    await importAIVisibilityExport(db, "p", valid);
    await importAIVisibilityExport(db, "p", valid);
    expect(rows()).toHaveLength(1);
    await importAIVisibilityExport(db, "p", { ...valid, observations: [{ ...item, answer: { citations: ["https://other.example"] } }] });
    expect(rows()).toHaveLength(2);
    expect(rows().map(row => row.version)).toEqual([1, 2]);
    expect(model.create).toHaveBeenCalledTimes(2);
  });

  it("does not accept access signals as visibility evidence", async () => {
    expect(() => parseAIVisibilityExport({ ...valid, robotsAllows: true, httpStatus: 200 })).toThrow();
    const { db } = mockDb();
    const [row] = await importAIVisibilityExport(db, "p", valid);
    expect(JSON.stringify(row.coverage)).not.toMatch(/robots|sitemap|user.agent|http/i);
  });
});
