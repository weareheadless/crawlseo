import { describe, expect, it } from "vitest";

import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

/**
 * A defect is ordered by severity and reach, never by how confident we are about
 * its demand.
 *
 * Before this test, the readiness band intercepted technical rows. The band pays a
 * fixed share of a ceiling and never reads `severity`, so "missing structured data
 * on 48 pages" on inmersionfreediving scored **23** with `measurement:
 * "unquantified"` — above the only content proposal on the board — while the same
 * defect with `measurement: "observed_baseline"` took the technical branch and
 * scored **6**.
 *
 * Work with *no* demand evidence was beating the same work *with* it, and severity
 * 0.05 and 0.95 both produced 23.
 */

function defect(overrides: Partial<ScoreInputs["worth"]> = {}): ScoreInputs {
  return {
    worth: {
      change: "Add Organization schema",
      volume: 2,
      intentFit: 0.5,
      readiness: "actionable",
      technical: true,
      windowDays: 28,
      measurement: "unquantified",
      targetPages: ["https://example.test/"],
      benefitTrack: "technical_health",
      intervention: "improve_journey",
      volumeSource: "unknown",
      businessValue: 0.9,
      severity: 0.3,
      ...overrides,
    },
    effort: { sizeFactor: 1, playTypeBase: 2 },
    freshness: 0.99,
    stability: 0.8,
    evidenceCompleteness: "both",
    winProbability: {
      authorityGap: null,
      pageStrength: 0.5,
      rankDistance: null,
      serpCompetition: 0.5,
      playTypeFactor: 1,
    },
  } as ScoreInputs;
}

describe("a technical defect is scored by severity and reach", () => {
  it("scores the same whether its demand is quantified or not", () => {
    // The whole point: missing demand evidence is not a promotion.
    const unquantified = computeScore(defect({ measurement: "unquantified" }));
    const measured = computeScore(defect({ measurement: "observed_baseline" }));
    expect(unquantified.scoreValue).toBe(measured.scoreValue);
  });

  it("moves with severity", () => {
    const low = computeScore(defect({ severity: 0.1 })).scoreValue;
    const high = computeScore(defect({ severity: 1 })).scoreValue;
    expect(high).toBeGreaterThan(low);
  });

  it("never reaches the readiness band's ceiling for unquantified work", () => {
    // The band pays up to 76% of a ceiling of 30 for an actionable row with no
    // demand evidence. A defect must not get there.
    const score = computeScore(defect({ measurement: "unquantified" })).scoreValue;
    expect(score).toBeLessThanOrEqual(14);
  });

  it("stays below a content proposal it used to outrank", () => {
    // inmersionfreediving, measured 2026-11-25: the schema defect scored 23 and
    // "New Spanish article: apnea as a sport" scored 7. The article is the work an
    // SEO would do first; the defect is a checkbox. The article's inputs below are
    // copied from that stored row, not invented — an earlier version of this test
    // guessed them and got 4 instead of 7.
    const article: ScoreInputs = {
      worth: {
        change: "New Spanish article: apnea as a sport, not sleep apnea",
        volume: 1300,
        intentFit: 0.35,
        readiness: "actionable",
        technical: false,
        windowDays: 28,
        measurement: "observed_baseline",
        targetPages: ["https://inmersionfreediving.com/es/apnea-deporte"],
        benefitTrack: "organic_growth",
        intervention: "create_asset",
        volumeSource: "provider",
        businessValue: 0.55,
        // Added to the stored row by P1-2; the fixture predated it, which is why this copy
        // scored 6 where the live row scores 16 (no source -> damped to 0.25 relevance).
        businessValueSource: "cluster",
        ctrAtPosition: null,
        unmeasured: false,
        coverageSummary: "Topic coverage: none",
        targetPosition: 10,
        currentPosition: null,
        observedImpressions: 0,
      },
      effort: { sizeFactor: 1, playTypeBase: 8 },
      freshness: 0.9,
      stability: 0.8,
      evidenceCompleteness: "both",
      winProbability: {
        authorityGap: null,
        pageStrength: null,
        rankDistance: null,
        playTypeFactor: 0.6,
        serpCompetition: null,
      },
      winProbabilitySource: {
        authorityGap: "assumed",
        pageStrength: "assumed",
        rankDistance: "assumed",
        playTypeFactor: "assumed",
        serpCompetition: "assumed",
      },
    } as unknown as ScoreInputs;
    const published = computeScore(article).scoreValue;
    // The literal moved when the score became a rate on the market (ASSESSMENT_VERSION 4):
    // the same stored row scores 16 where it scored 7, because 1,300 searches/month at
    // position 10 is 52 clicks and that is now what the number measures. Asserting 7 would
    // pin the test to a formula; what the test is for is the *relationship* with the defect.
    expect(published).toBeGreaterThan(10);
    const hygiene = computeScore(defect({ measurement: "unquantified" })).scoreValue;
    // Not asserting the article wins outright — D1 orders by evidence class — only
    // that hygiene no longer sits above it on the same number.
    expect(hygiene).toBeLessThan(published);
  });
});
