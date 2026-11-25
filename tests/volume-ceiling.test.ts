import { describe, expect, it } from "vitest";

import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

/**
 * CMP-005's central claim, tested at the scorer.
 *
 * The acceptance says: "a query with a provider volume but few impressions
 * produces an O1/O2 opportunity scored from estimated/measured, not capped at 15."
 *
 * Measured on 2026-11-24 after the measurement pass, this is what actually
 * happens — and the distinction matters, because two different ceilings exist:
 *
 * | Demand evidence | Assessment | Score | Why |
 * |---|---|---|---|
 * | nothing | hypothesis | 6 | capped at 15 by the hypothesis band |
 * | provider volume, no impressions | estimated | **27** | the ceiling no longer binds |
 * | provider volume, 5 impressions | hypothesis | 6 | the reach guard, not the ceiling |
 * | provider volume, 300 impressions | measured | 16 | measured, above the band |
 * | provider volume, 900 impressions | measured | 25 | measured, above the band |
 *
 * The 5-impression row is deliberately *not* lifted: a query the site is barely
 * shown for is not a large opportunity however large the market, and the honest
 * next step is to check intent and rank rather than book a 400-click win. That
 * guard is older than this issue and is not lowered to make rows appear.
 */

/** All four winnability inputs measured, so CMP-012's assumed-fight ceiling does not bind. */
const measuredSource = {
  rankDistance: "measured",
  authorityGap: "measured",
  pageStrength: "measured",
  serpCompetition: "measured",
  playTypeFactor: "assumed",
} as const;

const base = (over: Partial<ScoreInputs["worth"]> = {}): ScoreInputs => ({
  worth: {
    volume: null,
    ctrAtPosition: 0.015,
    businessValue: 0.9,
    businessValueSource: "knowledge",
    currentPosition: 15,
    targetPosition: 8,
    windowDays: 28,
    observedCtr: 0,
    observedImpressions: null,
    volumeSource: "unknown",
    ...over,
  },
  winProbability: {
    rankDistance: 0.35,
    authorityGap: null,
    pageStrength: null,
    serpCompetition: null,
    playTypeFactor: 0.8,
  },
  effort: { playTypeBase: 2, sizeFactor: 1 },
  evidenceCompleteness: "how",
  freshness: 0.9,
  stability: 0.8,
});

describe("CMP-005 the hypothesis ceiling stops binding once demand is measured", () => {
  it("caps a row with no demand evidence at the hypothesis band", () => {
    const result = computeScore(base());
    expect(result.impact.kind).toBe("hypothesis");
    expect(result.scoreValue).toBeLessThanOrEqual(15);
  });

  it("lifts a provider-volume row above the band, because the demand is measured", () => {
    // No impressions at all: the provider volume is the only demand evidence, and
    // it is a real measurement, so the row is `estimated` rather than unmeasured.
    const result = computeScore(base({ volume: 900, volumeSource: "provider" }));
    expect(result.impact.kind).toBe("estimated");
    expect(result.scoreValue).toBeGreaterThan(15);
    expect(result.impact.incrementalClicksPerMonth).toBeGreaterThan(0);
  });

  it("lifts a measured row with real reach above the band", () => {
    const result = computeScore(base({ volume: 900, volumeSource: "provider", observedImpressions: 300 }));
    expect(result.impact.kind).toBe("measured");
    expect(result.scoreValue).toBeGreaterThan(15);
  });

  it("does not lift a query the site is barely shown for, whatever the market size", () => {
    // The reach guard predates this issue and is a deliberate boundary: 900
    // searches/month against 5 impressions is a phrase the site does not compete
    // for yet. Measurement does not make reach exist.
    const result = computeScore(base({ volume: 900, volumeSource: "provider", observedImpressions: 5 }));
    expect(result.impact.kind).toBe("hypothesis");
    expect(result.impact.limitations.join(" ")).toContain("impressions");
  });

  it("orders two measured rows by the chance of winning, not by our current reach", () => {
    // This test used to assert that more impressions beat fewer at the same market and the
    // same position. That held because reach *was* the multiplier — `observed x CTR delta`
    // — which is the defect ASSESSMENT_VERSION 4 removed: it made priority a function of how
    // visible a site already is, so identical work scored 3 on a small site and 40 on a large
    // one. Its fixture was also internally impossible: 400 impressions a month at position 15
    // implies a market of ~1,100, not the 480 it declared.
    //
    // What must still be true, and is what an SEO is choosing between, is that two rows on
    // the same market differ by how winnable the fight is. Ranking 6th against weak
    // incumbents beats ranking 60th against strong ones, and the score has to say so.
    const winnable = computeScore({
      ...base({ volume: 480, volumeSource: "provider", observedImpressions: 200, currentPosition: 6 }),
      winProbability: { rankDistance: 0.95, authorityGap: 0.9, pageStrength: 0.8, serpCompetition: 0.9, playTypeFactor: 0.6 },
      winProbabilitySource: measuredSource,
    });
    const unlikely = computeScore({
      ...base({ volume: 480, volumeSource: "provider", observedImpressions: 200, currentPosition: 60 }),
      winProbability: { rankDistance: 0.1, authorityGap: 0.1, pageStrength: 0.2, serpCompetition: 0.15, playTypeFactor: 0.6 },
      winProbabilitySource: measuredSource,
    });
    expect(winnable.scoreValue).toBeGreaterThan(unlikely.scoreValue);
  });

  it("never scores a hypothesis row above a measured one with the same inputs", () => {
    const hypothesis = computeScore(base());
    const measured = computeScore(base({ volume: 480, volumeSource: "provider", observedImpressions: 200 }));
    expect(measured.scoreValue).toBeGreaterThan(hypothesis.scoreValue);
  });
});
