import { describe, expect, it } from "vitest";

import { computeScore, TECHNICAL_UPLIFT, type ScoreInputs } from "@/lib/funnel/scoring";

const base = (worth: Partial<ScoreInputs["worth"]> = {}): ScoreInputs => ({
  worth: { volume: 1_000, ctrAtPosition: 0.03, businessValue: 0.8, ...worth },
  winProbability: { rankDistance: 0.6, authorityGap: 0.6, pageStrength: 0.6, serpCompetition: 0.6, playTypeFactor: 0.7 },
  effort: { playTypeBase: 3, sizeFactor: 1 },
  evidenceCompleteness: "both",
  freshness: 1,
  stability: 0.9,
});

describe("scoring honesty", () => {
  /**
   * A question generated from business knowledge is not a searched query. Scored on
   * the same curve it carried 30–42 points on demand nobody had shown existed.
   */
  it("caps a question with unmeasured demand below any measured opportunity", () => {
    const unmeasured = computeScore(base({ volume: null, unmeasured: true }));
    const measured = computeScore(base({ volume: 1_000 }));
    expect(unmeasured.scoreValue).toBeLessThanOrEqual(5);
    expect(unmeasured.scoreValue).toBeLessThan(measured.scoreValue);
  });

  it("does not let an unmeasured opportunity outrank a small measured one", () => {
    const unmeasured = computeScore(base({ volume: null, unmeasured: true }));
    const modest = computeScore({ ...base({ volume: 50 }), effort: { playTypeBase: 12, sizeFactor: 1 } });
    expect(unmeasured.scoreValue).toBeLessThanOrEqual(modest.scoreValue);
  });

  /**
   * A page defect does not put all of that page's traffic at stake. Without an
   * uplift, page count alone pushed "missing schema on 513 pages" to the top of the
   * board, above a query already sitting at position 7.
   */
  it("discounts a technical fix to the traffic it can actually recover", () => {
    const full = computeScore(base({ volume: 5_000 }));
    const technical = computeScore(base({ volume: 5_000, uplift: TECHNICAL_UPLIFT }));
    expect(technical.scoreValue).toBeLessThan(full.scoreValue);
    expect(technical.inputs.worth.uplift).toBe(TECHNICAL_UPLIFT);
  });

  it("stores the uplift so the score stays recomputable", () => {
    const result = computeScore(base({ volume: 5_000, uplift: TECHNICAL_UPLIFT }));
    expect(result.inputs.worth.uplift).toBe(TECHNICAL_UPLIFT);
  });
});
