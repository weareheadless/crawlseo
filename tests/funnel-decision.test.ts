import { describe, expect, it } from "vitest";

import {
  assertDecision,
  decideRecommendation,
  type BusinessFit,
  type CoverageAssessment,
  type RecommendationInput,
} from "@/lib/funnel/decision";

/**
 * The contract that replaced "is the score high enough?".
 *
 * Each case below is a decision the expert review found the product got wrong, or a
 * branch the contract must settle before it is allowed to publish work.
 */

const fit = (state: BusinessFit["state"] = "supported"): BusinessFit => ({
  state,
  rationale: state === "supported" ? "the business sells this service" : "not shown",
  basis: state === "supported" ? ["business knowledge: services"] : [],
});

const coverage = (state: CoverageAssessment["state"], url = "https://site.test/service"): CoverageAssessment => ({
  pageUrl: url,
  state,
  method: "lexical",
  matchedTerms: state === "does_not_answer" ? [] : ["service"],
  excerpts: state === "answers" ? ["We provide the service."] : [],
  note: "assessed",
});

const base = (over: Partial<RecommendationInput> = {}): RecommendationInput => ({
  need: {
    statement: "Buyers ask what closing costs they will actually pay",
    audience: "international buyers",
    sources: ["https://buyer-forum.test/closing-costs"],
    observations: 3,
    state: "supported",
  },
  businessFit: fit(),
  coverage: [coverage("partially_answers")],
  coverageComplete: true,
  measurement: "unquantified",
  targetPages: ["https://site.test/closing"],
  change: "Add a worked closing-cost example and link it from the buyer guide",
  expectedBenefit: "Buyers can judge total cost before enquiring",
  uncertainty: ["the frequency of the question is not measured"],
  effort: "small",
  successMeasure: "the page answers the cost question in a buyer walkthrough",
  ...over,
});

describe("readiness", () => {
  it("makes a supported need actionable with no keyword volume at all", () => {
    const decision = decideRecommendation(base());
    expect(decision.readiness).toBe("actionable");
    expect(decision.measurement).toBe("unquantified");
    expect(decision.tracks).toContain("customer_value");
    expect(decision.intervention).toBe("update_page");
    expect(() => assertDecision(decision)).not.toThrow();
  });

  it("sends a supported need with no coverage assessment to a bounded investigation", () => {
    const decision = decideRecommendation(base({ coverage: [], coverageComplete: false }));
    expect(decision.readiness).toBe("needs_investigation");
    expect(decision.intervention).toBe("investigate");
  });

  it("turns a need that only a finding asserts into backlog, not work", () => {
    const decision = decideRecommendation(
      base({ need: { ...base().need!, state: "unverified" } })
    );
    expect(decision.readiness).toBe("research_backlog");
    expect(decision.change).toBeTruthy();
  });

  it("turns a need with no business-fit evidence into backlog, not work", () => {
    const decision = decideRecommendation(base({ businessFit: fit("unverified") }));
    expect(decision.readiness).toBe("research_backlog");
    expect(decision.evidenceState).toBe("unverified");
  });

  it("leaves an adequate answer alone even when a change is proposed", () => {
    const decision = decideRecommendation(base({ coverage: [coverage("answers")] }));
    expect(decision.readiness).toBe("no_action");
    expect(decision.intervention).toBe("maintain");
    expect(decision.tracks).toEqual([]);
    expect(() => assertDecision(decision)).not.toThrow();
  });

  it("treats an unassessable page as unknown, not as a demonstrated gap", () => {
    const decision = decideRecommendation(base({ coverage: [coverage("unassessable")] }));
    expect(decision.readiness).toBe("needs_investigation");
    expect(decision.intervention).toBe("investigate");
  });

  it("creates a new asset only when no existing page answers, the crawl is complete and none is targeted", () => {
    const decision = decideRecommendation(
      base({ coverage: [], coverageComplete: true, targetPages: [] })
    );
    expect(decision.intervention).toBe("create_asset");
    expect(decision.readiness).toBe("actionable");
  });

  it("does not create a new asset from an incomplete crawl", () => {
    const decision = decideRecommendation(
      base({ coverage: [], coverageComplete: false, targetPages: [] })
    );
    expect(decision.readiness).toBe("needs_investigation");
  });
});

describe("rejection", () => {
  it("rejects a contradicted premise instead of lowering its score", () => {
    const decision = decideRecommendation(base({
      need: {
        statement: "The site has no city-level entry point",
        audience: "buyers",
        sources: ["one aggregator result"],
        observations: 1,
        contradicted: true,
        contradictionReason: "the crawl holds 13 city pages",
      },
    }));
    expect(decision.readiness).toBe("rejected");
    expect(decision.evidenceState).toBe("contradicted");
    expect(decision.tracks).toEqual([]);
    expect(decision.reasons.join(" ")).toContain("13 city pages");
  });

  it("rejects research that found its own sources unusable", () => {
    const decision = decideRecommendation(base({
      need: {
        statement: "Corpus de sources hors sujet",
        audience: null,
        sources: ["r/Quebec", "r/QuebecLibre"],
        observations: 9,
        sourcesUnusable: true,
      },
    }));
    expect(decision.readiness).toBe("rejected");
    expect(decision.reasons.join(" ")).toContain("pipeline-quality");
  });

  it("rejects a need the business should not serve", () => {
    const decision = decideRecommendation(base({
      businessFit: { state: "contradicted", rationale: "the site sells Riviera Maya inventory, not Mexico City", basis: ["business knowledge: market"] },
    }));
    expect(decision.readiness).toBe("rejected");
  });

  it("never lets two evidence legs override a contradicted premise", () => {
    const decision = decideRecommendation(base({
      need: { statement: "The site has no city pages at all", audience: null, sources: ["a", "b"], observations: 5, contradicted: true },
      coverage: [coverage("answers"), coverage("answers", "https://site.test/cities")],
      targetPages: ["https://site.test/cities"],
    }));
    expect(decision.readiness).toBe("rejected");
  });
});

describe("technical problems", () => {
  it("makes a verified technical problem actionable without demand", () => {
    const decision = decideRecommendation(base({
      need: null,
      technical: { verified: true, problem: "internal links return 404", affectedPages: 39, causedByCrawlBlocking: false },
    }));
    expect(decision.readiness).toBe("actionable");
    expect(decision.tracks).toEqual(["technical_health"]);
    expect(decision.intervention).toBe("technical_fix");
  });

  it("treats a rate-limited fetch as an investigation, not a broken link", () => {
    const decision = decideRecommendation(base({
      need: null,
      technical: { verified: false, problem: "429 on /category/abat-jours", affectedPages: 1, causedByCrawlBlocking: true },
    }));
    expect(decision.readiness).toBe("needs_investigation");
    expect(decision.reasons.join(" ")).toContain("does not prove a defect");
  });
});

describe("validation", () => {
  it("refuses an actionable recommendation with no change or no success measure", () => {
    const decision = decideRecommendation(base());
    expect(() => assertDecision({ ...decision, change: "" })).toThrow(/stated change/);
    expect(() => assertDecision({ ...decision, successMeasure: "" })).toThrow(/success measure/);
  });

  it("keeps the measurement basis separate from readiness", () => {
    const withForecast = decideRecommendation(base({ measurement: "forecast" }));
    expect(withForecast.readiness).toBe("actionable");
    expect(withForecast.measurement).toBe("forecast");
  });
});
