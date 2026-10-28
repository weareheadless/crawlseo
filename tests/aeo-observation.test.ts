import { describe, expect, it, vi } from "vitest";
import { compareObservationRuns, createObservation, latestObservations, projectObservation } from "@/lib/aeo/observation";
import type { CreateObservationInput, ObservationRecord } from "@/lib/aeo/observation-types";

const input = (overrides: Partial<CreateObservationInput> = {}): CreateObservationInput => ({ projectId: "p1", question: "Which shop?", provider: "perplexity", surface: "perplexity_api", questionSetVersion: "qsv-1", askedAt: new Date("2026-01-01T00:00:00Z"), requestStatus: "succeeded", answerText: "Try Example", promptText: "Answer this", locale: "en-US", aiAnswerPresent: true, runId: "r1", citedSources: ["https://rival.example/"], mentionedBrands: [], ...overrides });
const client = (findMany = vi.fn().mockResolvedValue([])) => ({ aIVisibilityObservation: { upsert: vi.fn().mockResolvedValue({ id: "o1" }), findMany } }) as never;

describe("AEO observation record", () => {
  it("rejects failed or over-budget requests", async () => {
    await expect(createObservation(input({ requestStatus: "failed" }))).rejects.toThrow("failed request");
    await expect(createObservation(input({ requestStatus: "over_budget" }))).rejects.toThrow("over_budget");
  });
  it("stores absence as a first-class provider API observation", async () => {
    const db = client();
    await createObservation(input({ aiAnswerPresent: false, answerText: null }), db);
    expect((db as unknown as { aIVisibilityObservation: { upsert: ReturnType<typeof vi.fn> } }).aIVisibilityObservation.upsert.mock.calls[0][0].create).toMatchObject({ sourceKind: "provider_api", aiAnswerPresent: false, mentionedBrands: undefined, citedSources: undefined });
  });
  it("uses idempotent upsert identity for duplicate evidence", async () => {
    const db = client();
    await createObservation(input(), db); await createObservation(input(), db);
    const model = (db as unknown as { aIVisibilityObservation: { upsert: ReturnType<typeof vi.fn> } }).aIVisibilityObservation;
    expect(model.upsert).toHaveBeenCalledTimes(2);
    expect(model.upsert.mock.calls[0][0].where).toEqual(model.upsert.mock.calls[1][0].where);
  });
  it("rejects versionless observation input and unsupported provider/surface", async () => {
    await expect(createObservation(input({ questionSetVersion: " " }))).rejects.toThrow("version");
    await expect(createObservation(input({ provider: "google", surface: "perplexity_api" as never }))).rejects.toThrow("Unsupported");
  });
  it("distinguishes no observation, absent answer and answer without mentions", () => {
    expect(projectObservation(null).verdict).toBe("no_observation");
    const base = { id: "1", projectId: "p", question: "q", provider: "perplexity", modelSurface: "perplexity_api", observedAt: new Date(), questionSetVersion: "v", answerText: null, promptText: "p", locale: "en", country: null, device: null, aiAnswerPresent: false, modelVersion: null, runId: "r", citedSources: null, mentionedBrands: null } satisfies ObservationRecord;
    expect(projectObservation(base).verdict).toBe("answer_absent");
    expect(projectObservation({ ...base, aiAnswerPresent: true, answerText: "answer", mentionedBrands: [] }).verdict).toBe("no_brand_mention");
    expect(projectObservation({ ...base, aiAnswerPresent: true, answerText: "answer", mentionedBrands: ["Rival"] }, [], "Acme").verdict).toBe("brand_absent");
    expect(projectObservation({ ...base, aiAnswerPresent: true, answerText: "answer", mentionedBrands: ["Acme"] }, [], "Acme").verdict).toBe("answer_present");
  });
  it("project-scopes bounded latest reads and comparison to one question-set version", async () => {
    const findMany = vi.fn().mockResolvedValue([]); const db = client(findMany);
    await latestObservations("p1", 9999, db);
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { projectId: "p1", sourceKind: "provider_api" }, take: 500 });
    await compareObservationRuns("p1", "r1", "r2", "v2", db);
    expect(findMany.mock.calls[1][0].where).toMatchObject({ projectId: "p1", questionSetVersion: "v2", runId: { in: ["r1", "r2"] } });
  });
  it("computes competitor citation overlap", () => {
    const row = { id: "1", projectId: "p", question: "q", provider: "perplexity", modelSurface: "perplexity_api", observedAt: new Date(), questionSetVersion: "v", answerText: "An answer", promptText: null, locale: "en", country: null, device: null, aiAnswerPresent: true, modelVersion: null, runId: "r", citedSources: ["https://a.test", "https://b.test"], mentionedBrands: ["Acme"] } satisfies ObservationRecord;
    expect(projectObservation(row, ["https://b.test"]).competitorSourceOverlap).toEqual(["https://b.test"]);
  });
});
