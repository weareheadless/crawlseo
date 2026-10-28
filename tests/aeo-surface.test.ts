import { describe, expect, it } from "vitest";
import { projectEvaluationSurface } from "@/lib/aeo/surface";
import type { ObservationRecord } from "@/lib/aeo/observation-types";

const row = (overrides: Partial<ObservationRecord> = {}): ObservationRecord => ({
  id: "o1", projectId: "p1", question: "Which bakery?", provider: "perplexity", modelSurface: "perplexity_api",
  observedAt: new Date("2026-01-01T00:00:00Z"), questionSetVersion: "v1", answerText: "Try Acme Bakery.",
  promptText: "Which bakery?", locale: "en-US", country: "US", device: "desktop", aiAnswerPresent: true,
  modelVersion: "model", runId: "r1", citedSources: ["https://acme.test/a", "https://example.org/guide"], mentionedBrands: ["Acme"], ...overrides,
});

describe("projectEvaluationSurface", () => {
  it("reports no observations for requested questions and each surface", () => {
    const result = projectEvaluationSurface({ projectId: "p1", questions: ["Which bakery?"], observations: [] });
    expect(result.questionSetVersion).toBeNull();
    expect(result.questions[0].surfaces).toHaveLength(2);
    expect(result.questions[0].surfaces[0].verdict).toBe("no_observation");
  });

  it("distinguishes absent answers, brand absence and brand presence", () => {
    const result = projectEvaluationSurface({ projectId: "p1", brandOfInterest: "Acme", questions: ["Which bakery?"], observations: [
      row({ aiAnswerPresent: false, answerText: null, citedSources: null, mentionedBrands: null }),
      row({ id: "o2", provider: "google", modelSurface: "ai_overview", aiAnswerPresent: false, answerText: null, citedSources: null, mentionedBrands: null }),
    ] });
    expect(result.questions[0].surfaces.map((s) => s.verdict)).toEqual(["answer_absent", "answer_absent"]);
    const present = projectEvaluationSurface({ projectId: "p1", brandOfInterest: "Acme", questions: ["Which bakery?"], observations: [row()] });
    expect(present.questions[0].surfaces[0].verdict).toBe("brand_present");
    const absent = projectEvaluationSurface({ projectId: "p1", brandOfInterest: "Acme", questions: ["Which bakery?"], observations: [row({ mentionedBrands: [] })] });
    expect(absent.questions[0].surfaces[0].verdict).toBe("brand_absent");
  });

  it("computes citation domains and competitor overlap, and truncation disclosure", () => {
    const result = projectEvaluationSurface({ projectId: "p1", questions: ["Which bakery?"], observations: [row({ citedSources: Array.from({ length: 4 }, (_, i) => `https://domain${i}.test/p`) })], competitorUrls: ["https://domain0.test/other"], maxItems: 2 });
    expect(result.questions[0].surfaces[0].competitorOverlapCount).toBe(1);
    expect(result.questions[0].surfaces[0].citedDomains).toEqual(["domain0.test", "domain1.test"]);
    expect(result.questions[0].surfaces[0].citationsTruncated).toBe(true);
  });

  it("does not diff across question-set versions and diffs matching versions", () => {
    const base = row({ runId: "before" });
    const mismatch = projectEvaluationSurface({ projectId: "p1", questions: [base.question], observations: [base, row({ id: "o2", runId: "after", questionSetVersion: "v2" })], compareRuns: { before: "before", after: "after" } });
    expect(mismatch.questions[0].surfaces[0].diff).toBeNull();
    const same = projectEvaluationSurface({ projectId: "p1", questions: [base.question], observations: [base, row({ id: "o2", runId: "after", citedSources: ["https://new.test"] })], compareRuns: { before: "before", after: "after" } });
    expect(same.questions[0].surfaces[0].diff?.citationAdded).toEqual(["https://new.test"]);
  });

  it("isolates observations to the requested project", () => {
    const result = projectEvaluationSurface({ projectId: "p1", questions: ["Which bakery?"], observations: [row({ projectId: "p2" })] });
    expect(result.questions[0].surfaces.every((s) => s.verdict === "no_observation")).toBe(true);
  });

  it("shows failed and over-budget outcomes only when explicitly attributed", () => {
    const result = projectEvaluationSurface({ projectId: "p1", questions: ["Which bakery?"], observations: [], outcomes: [
      { projectId: "p1", question: "Which bakery?", surface: "perplexity_api", runId: "r", state: "failed" },
      { projectId: "p1", question: "Which bakery?", surface: "ai_overview", runId: "r", state: "over_budget" },
    ] });
    expect(result.questions[0].surfaces.map((s) => s.verdict)).toEqual(["failed", "over_budget"]);
  });
});
