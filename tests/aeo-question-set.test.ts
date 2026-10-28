import { describe, expect, it } from "vitest";
import { generateQuestionSet } from "../lib/aeo/question-set";

const site = (name = "Willow Studio") => ({
  businessKnowledge: { revision: 4, acceptedRevision: 3, fields: { businessName: { value: name }, services: { value: ["wedding photography", "portrait sessions"] }, location: { value: "Portland" }, differentiators: { value: ["documentary style"] }, concerns: { value: ["delivery time"] } } },
  profile: { audience: ["engaged couples"], topics: ["wedding photography"], services: ["wedding photography"], country: "US", language: "en" },
  research: { runs: [{ id: "run-1", questions: ["How much does wedding photography cost?"] }], findings: [{ id: "finding-1", runId: "run-1", theme: "compare packages", summary: "Couples compare album and editing packages" }] },
});

describe("generateQuestionSet", () => {
  it("is deterministic with stable IDs/hash and changes version when its input changes", () => {
    const input = site();
    const first = generateQuestionSet(input);
    expect(generateQuestionSet(input)).toEqual(first);
    expect(generateQuestionSet(site("Oak Studio")).version).not.toBe(first.version);
  });
  it("bounds output, covers intents, and carries provenance and profile locale", () => {
    const result = generateQuestionSet(site(), { limit: 20 });
    expect(result.questions.length).toBeLessThanOrEqual(20);
    expect(new Set(result.questions.map((q) => q.intent))).toEqual(new Set(["discovery", "comparison", "suitability", "local", "trust_risk"]));
    expect(result.locale).toEqual({ country: "US", language: "en" });
    expect(result.questions.every((q) => q.id && q.provenance.length > 0)).toBe(true);
    expect(result.questions.some((q) => q.provenance.some((p) => p.kind === "business_knowledge" && p.revision === 3))).toBe(true);
    expect(result.questions.some((q) => q.provenance.some((p) => p.kind === "research_finding" && p.id === "finding-1"))).toBe(true);
  });
  it("represents unrecorded inputs and refuses to invent questions without business data", () => {
    const result = generateQuestionSet({ profile: { language: "fr", country: "CA" } });
    expect(result.questions).toEqual([]);
    expect(result.emptyReason).toBe("no_business_data");
    expect(result.provenance).toEqual([{ kind: "not_recorded" }]);
  });
  it("deduplicates normalized research questions and generalizes to another site", () => {
    const input = site();
    input.research.runs[0].questions.push("  HOW MUCH DOES WEDDING PHOTOGRAPHY COST? ");
    const result = generateQuestionSet(input);
    expect(result.questions.filter((q) => q.text.toLowerCase().includes("how much does wedding photography cost")).length).toBe(1);
    expect(generateQuestionSet(site("Oak Studio")).questions).not.toEqual(result.questions);
  });
});
