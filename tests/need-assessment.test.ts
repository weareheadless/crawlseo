import { describe, expect, it } from "vitest";

import {
  minimumReview,
  parseNeedAssessment,
  parsePersistedAssessment,
  type NeedAssessmentInput,
} from "@/lib/research/need-assessment";

/**
 * Validation of the assessment, not of the model.
 *
 * The model's answer is untrusted input. These tests prove that an answer citing a
 * page we did not supply, or a quote that is not on the page, cannot become a
 * supported conclusion or a page change.
 */

const input: NeedAssessmentInput = {
  statement: "Buyers ask what closing costs they will actually pay",
  label: "Closing and title process",
  audience: "international buyers",
  market: "Mexico",
  businessFacts: [
    {
      field: "services",
      values: ["property purchase support"],
      sourceUrl: "https://site.test/about",
      provenance: "ai_observation/assumed/model",
    },
  ],
  pages: [
    {
      url: "https://site.test/closing",
      title: "Closing costs",
      contentText:
        "Closing costs include the appraisal, the inspection, the notary fee and the registration tax. We explain each line in the quotation.",
    },
  ],
  sources: [
    {
      url: "https://forum.test/closing",
      title: "What did you pay in closing costs?",
      excerpt: "We were surprised by the notary fee and the registration tax.",
      provider: "reddit_serp",
    },
  ],
  coverageComplete: true,
};

const valid = {
  premise: {
    state: "unverified",
    rationale: "The pages do not settle whether the site already covers this.",
    evidence_urls: [],
  },
  need: {
    state: "supported",
    rationale: "A buyer thread describes surprise at the notary fee.",
    evidence_urls: ["https://forum.test/closing"],
  },
  offer_fit: {
    state: "supported",
    rationale: "The site supports property purchases.",
    evidence_urls: ["https://site.test/about"],
  },
  coverage: [
    {
      url: "https://site.test/closing",
      state: "partially_answers",
      rationale: "It lists the lines but gives no figures.",
      excerpts: ["Closing costs include the appraisal, the inspection, the notary fee and the registration tax."],
    },
  ],
  intervention: "update_page",
  change: "Add current fee ranges to each closing-cost line.",
  target_pages: ["https://site.test/closing"],
  expected_benefit: "A buyer can budget before committing.",
  uncertainty: ["fee ranges change by state"],
  review: "legal",
  success_measure: "A buyer can state the expected range after reading.",
};

describe("assessment validation", () => {
  it("accepts an assessment whose references and quotes check out", () => {
    const result = parseNeedAssessment(valid, input, "fixture-model");
    expect(result.assessment).toBeTruthy();
    expect(result.assessment!.need.state).toBe("supported");
    expect(result.assessment!.coverage[0].state).toBe("partially_answers");
    expect(result.assessment!.intervention).toBe("update_page");
    expect(result.problems).toEqual([]);
  });

  it("discards an evidence URL that was not supplied", () => {
    const result = parseNeedAssessment(
      {
        ...valid,
        need: { ...valid.need, evidence_urls: ["https://invented.test/proof"] },
      },
      input,
      "fixture-model"
    );
    expect(result.assessment!.need.state).toBe("unverified");
    expect(result.problems.join(" ")).toContain("not supplied");
  });

  it("discards a coverage claim whose quote is not on the page", () => {
    const result = parseNeedAssessment(
      {
        ...valid,
        coverage: [{ ...valid.coverage[0], excerpts: ["We charge a flat fee of 500 dollars."] }],
      },
      input,
      "fixture-model"
    );
    expect(result.assessment!.coverage).toEqual([]);
    expect(result.problems.join(" ")).toContain("does not occur");
    expect(result.assessment!.intervention).toBe("investigate");
  });

  it("does not let a page change name a page that was not supplied", () => {
    const result = parseNeedAssessment(
      {
        ...valid,
        target_pages: ["https://site.test/somewhere-else"],
      },
      input,
      "fixture-model"
    );
    expect(result.assessment!.intervention).toBe("investigate");
    expect(result.assessment!.targetPages).toEqual([]);
  });

  it("blanks a change attached to a maintain decision", () => {
    const result = parseNeedAssessment(
      {
        ...valid,
        coverage: [{ ...valid.coverage[0], state: "answers" }],
        intervention: "maintain",
      },
      input,
      "fixture-model"
    );
    expect(result.assessment!.intervention).toBe("maintain");
    expect(result.assessment!.change).toBe("");
  });

  it("never lowers the review requirement for a high-risk subject", () => {
    const result = parseNeedAssessment(
      { ...valid, review: "none" },
      { ...input, statement: "A beginner asks about decompression sickness and lanyard safety" },
      "fixture-model"
    );
    expect(result.assessment!.review).toBe("medical");
  });

  it("records an unparseable answer as no assessment", () => {
    const result = parseNeedAssessment("not json", input, "fixture-model");
    expect(result.assessment).toBeNull();
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("parses a persisted assessment and refuses a malformed one", () => {
    const persisted = {
      premise: { state: "unverified", rationale: "not assessed", evidenceUrls: [] },
      need: { state: "supported", rationale: "a buyer asked", evidenceUrls: ["https://forum.test/closing"] },
      offerFit: { state: "supported", rationale: "the site sells this", evidenceUrls: ["https://site.test/about"] },
      coverage: [],
      intervention: "investigate",
      change: "Check the closing page",
      targetPages: [],
      expectedBenefit: "",
      uncertainty: [],
      review: "none",
      successMeasure: "",
      model: "fixture",
      promptVersion: "need-assessment/1",
      assessedAt: "2026-11-04T00:00:00.000Z",
    };
    const parsed = parsePersistedAssessment(JSON.stringify(persisted));
    expect(parsed?.offerFit.state).toBe("supported");
    expect(parsePersistedAssessment("{bad json")).toBeNull();
    expect(parsePersistedAssessment({ need: { state: "maybe" } })).toBeNull();
  });

  it("normalises a persisted assessment with missing optional arrays", () => {
    const parsed = parsePersistedAssessment({
      need: { state: "supported", rationale: "r" },
      offerFit: { state: "supported", rationale: "r" },
      coverage: [{ pageUrl: "https://site.test/closing", state: "does_not_answer" }],
      intervention: "update_page",
      change: "Add a price range",
    });
    expect(parsed).toBeTruthy();
    expect(parsed!.targetPages).toEqual([]);
    expect(parsed!.uncertainty).toEqual([]);
    expect(parsed!.review).toBe("none");
    expect(parsed!.coverage[0].method).toBe("semantic");
  });

  it("refuses a persisted assessment whose coverage or need state is unusable", () => {
    expect(parsePersistedAssessment({
      need: { state: "maybe", rationale: "r" },
      offerFit: { state: "supported", rationale: "r" },
      coverage: [],
    })).toBeNull();
    expect(parsePersistedAssessment({
      need: { state: "supported", rationale: "r" },
      offerFit: { state: "supported", rationale: "r" },
      coverage: "not a list",
    })).toBeNull();
  });
});

describe("minimum review", () => {
  it("requires medical review for medical and diving-safety needs", () => {
    expect(minimumReview("decompression sickness after a deep dive")).toBe("medical");
    expect(minimumReview("lanyard safety for a beginner")).toBe("subject_matter_expert");
  });

  it("requires legal review for title and trust questions", () => {
    expect(minimumReview("how a fideicomiso trust deed works")).toBe("legal");
  });

  it("requires no special review for a price question", () => {
    expect(minimumReview("what a fitted wardrobe costs")).toBe("none");
  });
});
