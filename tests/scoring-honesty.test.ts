import { describe, expect, it } from "vitest";

import { assessImpact, ctrCurve } from "@/lib/funnel/impact";
import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

const base = (worth: Partial<ScoreInputs["worth"]> = {}): ScoreInputs => ({
  worth: { volume: 1_000, ctrAtPosition: 0.03, businessValue: 0.8, ...worth },
  winProbability: { rankDistance: 0.6, authorityGap: 0.6, pageStrength: 0.6, serpCompetition: 0.6, playTypeFactor: 0.7 },
  effort: { playTypeBase: 3, sizeFactor: 1 },
  evidenceCompleteness: "both",
  freshness: 1,
  stability: 0.9,
});

describe("impact assessment", () => {
  it("counts only the clicks a play adds, not the ones the page already gets", () => {
    const assessment = assessImpact({
      volume: 1_000,
      volumeSource: "first_party",
      observedCtr: 0.04,
      currentPosition: 7,
      targetPosition: 3,
      windowDays: 28,
    });
    expect(assessment.kind).toBe("measured");
    // 1000 impressions × (0.15 − 0.04) × 30/28, not 1000 × 0.15.
    expect(assessment.incrementalClicksPerMonth).toBeCloseTo(1_000 * 0.11 * (30 / 28), 4);
    expect(assessment.limitations.length).toBeGreaterThan(0);
  });

  it("never reports a negative upside when the target is worse than now", () => {
    const assessment = assessImpact({ volume: 500, volumeSource: "first_party", observedCtr: 0.2, targetPosition: 3, windowDays: 28 });
    expect(assessment.incrementalClicksPerMonth).toBe(0);
  });

  it("labels a provider estimate as estimated and says what it assumes", () => {
    const assessment = assessImpact({ volume: 3_600, volumeSource: "provider", currentPosition: 7, targetPosition: 3 });
    expect(assessment.kind).toBe("estimated");
    expect(assessment.basis).toBe("provider_volume");
    expect(assessment.limitations.join(" ")).toContain("whole volume");
  });

  it("returns a hypothesis when there is no demand evidence", () => {
    const assessment = assessImpact({ volume: null, volumeSource: "unknown" });
    expect(assessment.kind).toBe("hypothesis");
    expect(assessment.incrementalClicksPerMonth).toBeNull();
  });

  it("treats a declared proxy as a hypothesis, not a measurement", () => {
    const assessment = assessImpact({ volume: 10, volumeSource: "impact_proxy" });
    expect(assessment.kind).toBe("hypothesis");
  });

  it("does not quantify a technical defect's traffic", () => {
    const assessment = assessImpact({ volume: 300, volumeSource: "first_party", technical: true, severity: 0.6 });
    expect(assessment.kind).toBe("technical");
    expect(assessment.incrementalClicksPerMonth).toBeNull();
  });

  it("uses a declared CTR curve for a position", () => {
    expect(ctrCurve(1)).toBe(0.28);
    expect(ctrCurve(7)).toBe(0.04);
    expect(ctrCurve(null)).toBeNull();
  });
});

describe("priority index", () => {
  it("no longer invents demand for a query with no volume", () => {
    const unknown = computeScore(base({ volume: null, volumeSource: "unknown" }));
    expect(unknown.impact.kind).toBe("hypothesis");
    expect(unknown.scoreValue).toBeLessThanOrEqual(20);
  });

  it("orders measured incremental upside above a hypothesis", () => {
    const measured = computeScore(base({ volume: 1_000, volumeSource: "first_party", observedCtr: 0.01, targetPosition: 3, windowDays: 28 }));
    const hypothesis = computeScore(base({ volume: null, volumeSource: "unknown" }));
    expect(measured.scoreValue).toBeGreaterThan(hypothesis.scoreValue);
  });

  it("does not rank a technical fix by page count alone", () => {
    const technical = computeScore(base({ volume: 300, volumeSource: "first_party", technical: true, severity: 0.6 }));
    const measured = computeScore(base({ volume: 1_000, volumeSource: "first_party", observedCtr: 0.01, targetPosition: 3, windowDays: 28 }));
    expect(technical.scoreValue).toBeLessThanOrEqual(40);
    expect(technical.impact.incrementalClicksPerMonth).toBeNull();
    expect(measured.scoreValue).toBeGreaterThan(technical.scoreValue);
  });

  it("caps a generated question below anything measured", () => {
    const unmeasured = computeScore(base({ volume: null, unmeasured: true }));
    expect(unmeasured.scoreValue).toBeLessThanOrEqual(5);
  });

  it("stores the impact assessment so the board can show its basis", () => {
    const result = computeScore(base({ volume: 500, volumeSource: "provider", currentPosition: 8, targetPosition: 3 }));
    expect(result.impact.kind).toBe("estimated");
    expect(result.impact.assumptions.targetPosition).toBe(3);
  });
});
