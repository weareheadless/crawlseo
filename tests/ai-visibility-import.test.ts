import { describe, expect, it, vi } from "vitest";
import { importAIVisibilityExport, normalizeAIVisibilityExport } from "@/lib/research/ai-visibility-import";
import { AI_VISIBILITY_CAPABILITY_VERSION } from "@/lib/research/ai-visibility-capabilities";

const item = { question: "best bike shop?", answer: { mentions: ["Acme"], recommendations: ["Acme"], citations: ["https://acme.example"] } };
const valid = {
  schemaVersion: "ai-visibility-export-v1",
  provider: "perplexity",
  modelSurface: "sonar-web",
  observedAt: "2026-10-27T04:00:00Z",
  questionSetVersion: "questions-v2",
  sourceKind: "provider_export",
  rawExportReference: "operator-upload:export-17.json",
  denominator: 1,
  observations: [{ query: item.question, responseEvidence: { mentionedBrands: ["Acme"], recommendedBrands: ["Acme"], citedUrls: ["https://acme.example"] } }],
};
const capabilities = { version: AI_VISIBILITY_CAPABILITY_VERSION, providers: [{
  provider: "Perplexity", dashboard: { availability: "unknown" as const, reasonCode: "not_inventoried" },
  apiOrExport: { availability: "available" as const, details: "versioned export" }, unavailableSurfaces: [],
}] };

function mockDb() {
  let rows: any[] = [];
  const model = {
    findFirst: vi.fn(async ({ where }: any) => rows.filter(row => Object.entries(where).every(([key, val]) => row[key]?.toString() === val?.toString())).sort((a, b) => b.version - a.version)[0] ?? null),
    create: vi.fn(async ({ data }: any) => { const row = { id: `row-${rows.length + 1}`, ...data }; rows.push(row); return row; }),
  };
  return { db: { aIVisibilityObservation: model } as any, model, rows: () => rows };
}

describe("explicit AI visibility import", () => {
  it("normalizes and stores full provenance with evidence kept separate", async () => {
    const { db, rows } = mockDb();
    const [stored] = await importAIVisibilityExport(db, "project-1", valid, capabilities);
    expect(stored).toMatchObject({ projectId: "project-1", question: item.question, provider: "perplexity", modelSurface: "sonar-web", questionSetVersion: "questions-v2", sourceKind: "provider_export", rawExportReference: valid.rawExportReference, denominator: 1, version: 1, mentions: ["Acme"], recommendations: ["Acme"], citations: ["https://acme.example"] });
    expect(stored.observedAt).toEqual(new Date(valid.observedAt));
    expect(rows()).toHaveLength(1);
  });

  it("rejects malformed, unversioned, unsupported-provider and missing-question-set exports", () => {
    for (const body of [
      { ...valid, schemaVersion: undefined },
      { ...valid, questionSetVersion: "" },
      { ...valid, provider: "unsupported" },
      { ...valid, observations: [{ query: "", responseEvidence: null }] },
    ]) expect(() => normalizeAIVisibilityExport(body, capabilities)).toThrow();
    for (const body of [{ ...valid, provider: "unsupported" }, { ...valid, schemaVersion: "future-v2" }]) {
      expect(() => normalizeAIVisibilityExport(body, capabilities)).toThrow(/supported pairs: perplexity\/ai-visibility-export-v1/);
    }
  });

  it("requires the capability matrix to declare an available export surface", async () => {
    const { db } = mockDb();
    const unavailable = { ...capabilities, providers: [{ ...capabilities.providers[0], apiOrExport: { availability: "unavailable" as const, reasonCode: "no_export" } }] };
    await expect(importAIVisibilityExport(db, "p", valid, unavailable)).rejects.toThrow(/apiOrExport capability is unavailable/);
    const missing = { ...capabilities, providers: [] };
    await expect(importAIVisibilityExport(db, "p", valid, missing)).rejects.toThrow(/apiOrExport capability is not_listed/);
  });

  it("keeps unobserved answers and zero denominators unknown, not zero", async () => {
    const { db } = mockDb();
    const [absent] = await importAIVisibilityExport(db, "p", { ...valid, observations: [{ query: "q", responseEvidence: null }] }, capabilities);
    expect(absent.coverage).toEqual({ status: "unknown", reasonCode: "provider_not_observed" });
    const { db: zeroDb } = mockDb();
    const [zero] = await importAIVisibilityExport(zeroDb, "p", { ...valid, denominator: 0 }, capabilities);
    expect(zero.coverage).toEqual({ status: "unknown", reasonCode: "zero_denominator" });
  });

  it("is idempotent for the same export and versions a changed observation", async () => {
    const { db, model, rows } = mockDb();
    await importAIVisibilityExport(db, "p", valid, capabilities);
    await importAIVisibilityExport(db, "p", valid, capabilities);
    expect(rows()).toHaveLength(1);
    await importAIVisibilityExport(db, "p", { ...valid, observations: [{ query: item.question, responseEvidence: { citedUrls: ["https://other.example"] } }] }, capabilities);
    expect(rows()).toHaveLength(2);
    expect(rows().map(row => row.version)).toEqual([1, 2]);
    expect(model.create).toHaveBeenCalledTimes(2);
  });

  it("does not accept access signals as visibility evidence", async () => {
    expect(() => normalizeAIVisibilityExport({ ...valid, robotsAllows: true, httpStatus: 200 }, capabilities)).toThrow();
    const { db } = mockDb();
    const [row] = await importAIVisibilityExport(db, "p", valid, capabilities);
    expect(JSON.stringify(row.coverage)).not.toMatch(/robots|sitemap|user.agent|http/i);
  });
});
