import { describe, expect, it, vi } from "vitest";

import {
  assertSingleCohort,
  ingestAiVisibility,
  validateObservation,
  visibilityCohorts,
  type AiVisibilityObservation,
} from "@/lib/dataforseo/ai-visibility-adapter";

const AT = new Date("2026-11-02T00:00:00.000Z");

const obs = (over: Partial<AiVisibilityObservation> = {}): AiVisibilityObservation => ({
  question: "how much does a freediving course cost",
  surface: "perplexity_api",
  model: "sonar",
  locale: "en-US",
  askedAt: AT,
  samples: 3,
  citationsOfUs: 0,
  citationsOfCompetitor: 2,
  dataset: "ds-1",
  answered: true,
  rawExportReference: "export-1",
  ...over,
});

function fakeDb() {
  const raws: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const db = {
    rawProviderResponse: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        raws.push(args.data);
        return { id: "raw-ai-1" };
      }),
      findUnique: vi.fn(async () => ({ costMicros: BigInt(500), status: "ok" })),
    },
    evidenceRecord: {
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
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

describe("DS-06 AI visibility adapter", () => {
  it("stores an observed zero as a real measurement", async () => {
    const { db, evidence } = fakeDb();
    const result = await ingestAiVisibility(db, [obs({ citationsOfUs: 0, citationsOfCompetitor: 2 })], {
      projectId: "p1", requestedAt: AT, costMicros: BigInt(500), payload: {}, providerTaskId: "ai-1",
    });
    expect(result.stored).toBe(1);
    expect(result.refused).toEqual([]);
    const metrics = evidence[0].metrics as Record<string, { value: number }>;
    expect(metrics["provider:citedCount"].value).toBe(0);
    expect(metrics["provider:competitorCitedCount"].value).toBe(2);
    expect(metrics["provider:samples"].value).toBe(3);
  });

  it("keeps the dataset, surface, model, locale and observation time", async () => {
    const { db, evidence } = fakeDb();
    await ingestAiVisibility(db, [obs()], { projectId: "p1", requestedAt: AT, costMicros: BigInt(500), payload: {}, providerTaskId: "ai-1" });
    expect(evidence[0].dimensions).toMatchObject({
      question: "how much does a freediving course cost",
      surface: "perplexity_api",
      model: "sonar",
      locale: "en-US",
      dataset: "ds-1",
      rawExportReference: "export-1",
    });
    expect(evidence[0].observedAt).toEqual(AT);
  });

  it("refuses an unanswered question: absence is not a measurement", async () => {
    const { db, evidence } = fakeDb();
    const result = await ingestAiVisibility(db, [obs({ answered: false })], {
      projectId: "p1", requestedAt: AT, costMicros: BigInt(500), payload: {}, providerTaskId: "ai-1",
    });
    expect(result.stored).toBe(0);
    expect(result.refused[0].reason).toMatch(/absence is not a measurement/);
    expect(evidence).toHaveLength(0);
  });

  it("refuses an unsupported engine instead of recording a zero", async () => {
    const { db } = fakeDb();
    const result = await ingestAiVisibility(db, [obs({ surface: "some_new_engine" })], {
      projectId: "p1", requestedAt: AT, costMicros: BigInt(500), payload: {}, providerTaskId: "ai-1",
    });
    expect(result.refused[0].reason).toMatch(/unsupported surface/);
  });

  it("refuses observations without a sample count or with impossible citations", () => {
    expect(validateObservation(obs({ samples: 0 }))).toMatch(/sample count/);
    expect(validateObservation(obs({ samples: 2, citationsOfUs: 5 }))).toMatch(/exceeds the sample/);
    expect(validateObservation(obs({ locale: " " }))).toMatch(/locale/);
    expect(validateObservation(obs({ rawExportReference: "" }))).toMatch(/raw reference/);
    expect(validateObservation(obs({ askedAt: new Date("nope") }))).toMatch(/observation time/);
  });

  it("reports refusals explicitly rather than dropping them", async () => {
    const { db } = fakeDb();
    const result = await ingestAiVisibility(db, [obs(), obs({ answered: false, question: "q2" })], {
      projectId: "p1", requestedAt: AT, costMicros: BigInt(500), payload: {}, providerTaskId: "ai-1",
    });
    expect(result.stored).toBe(1);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].question).toBe("q2");
  });
});

describe("DS-06 cohort discipline", () => {
  it("computes citation rate per cohort, never across engines", () => {
    const cohorts = visibilityCohorts([
      { surface: "perplexity_api", model: "sonar", locale: "en-US", question: "q1", cited: 1 },
      { surface: "perplexity_api", model: "sonar", locale: "en-US", question: "q2", cited: 0 },
      { surface: "google_ai_overview", model: null, locale: "en-US", question: "q1", cited: 0 },
    ]);
    expect(cohorts).toHaveLength(2);
    const perplexity = cohorts.find((cohort) => cohort.surface === "perplexity_api")!;
    expect(perplexity.questions).toBe(2);
    expect(perplexity.citedQuestions).toBe(1);
    expect(perplexity.uncitedQuestions).toBe(1);
    expect(perplexity.citationRate).toBe(0.5);
    const google = cohorts.find((cohort) => cohort.surface === "google_ai_overview")!;
    expect(google.citationRate).toBe(0);
  });

  it("counts a question once even when sampled several times", () => {
    const cohorts = visibilityCohorts([
      { surface: "perplexity_api", model: "sonar", locale: "en-US", question: "q1", cited: 0 },
      { surface: "perplexity_api", model: "sonar", locale: "en-US", question: "q1", cited: 1 },
    ]);
    expect(cohorts[0].questions).toBe(1);
    expect(cohorts[0].citedQuestions).toBe(1);
    expect(cohorts[0].observations).toBe(2);
  });

  it("refuses to aggregate across cohorts", () => {
    const cohorts = visibilityCohorts([
      { surface: "perplexity_api", model: "sonar", locale: "en-US", question: "q1", cited: 1 },
      { surface: "google_ai_overview", model: null, locale: "en-US", question: "q1", cited: 0 },
    ]);
    expect(() => assertSingleCohort(cohorts)).toThrow(/cannot aggregate visibility/);
    expect(() => assertSingleCohort([cohorts[0]])).not.toThrow();
  });

  it("separates locales instead of pooling them", () => {
    const cohorts = visibilityCohorts([
      { surface: "perplexity_api", model: "sonar", locale: "en-US", question: "q1", cited: 1 },
      { surface: "perplexity_api", model: "sonar", locale: "es-MX", question: "q1", cited: 0 },
    ]);
    expect(cohorts).toHaveLength(2);
    expect(() => assertSingleCohort(cohorts)).toThrow();
  });
});
