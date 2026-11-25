import { describe, expect, it } from "vitest";

import {
  compareOpportunities,
  EVIDENCE_CLASS_ORDER,
  evidenceClassRank,
  sortOpportunities,
} from "@/lib/funnel/opportunity-order";
import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

/**
 * D1: the evidence class orders the board; the score orders within a class.
 *
 * One number cannot do both jobs. `scoreValue` answers "how much is this worth"; it
 * cannot also answer "how sure are we that the worth is real". That gap produced the
 * alaguillotine inversion, measured 2026-11-25 before this change:
 *
 * ```
 * 42  estimated   a hub behind a page that does not exist
 *  3  measured    'alex karp height', ranking 29 with 76 real impressions
 * ```
 *
 * The hub was 14x the measured row and no part of that ratio was evidence. After this
 * change the measured row is first on the board and the hub sits in its own band.
 */

const at = (iso: string) => new Date(iso).toISOString();

describe("a projection never displaces a measurement", () => {
  it("puts a measured row above a bigger estimated one", () => {
    // The exact inversion, as rows.
    const rows = [
      { id: "hub", evidenceClass: "estimated", scoreValue: 42, firstDetectedAt: at("2026-11-01") },
      { id: "karp", evidenceClass: "measured", scoreValue: 3, firstDetectedAt: at("2026-11-01") },
    ];
    expect(sortOpportunities(rows).map((row) => row.id)).toEqual(["karp", "hub"]);
    expect(compareOpportunities(rows[1], rows[0])).toBeLessThan(0);
  });

  it("orders the four classes and sorts by score inside each", () => {
    const rows = [
      { id: "hyp-high", evidenceClass: "hypothesis", scoreValue: 90, firstDetectedAt: at("2026-01-01") },
      { id: "est-low", evidenceClass: "estimated", scoreValue: 10, firstDetectedAt: at("2026-01-01") },
      { id: "meas-low", evidenceClass: "measured", scoreValue: 2, firstDetectedAt: at("2026-01-01") },
      { id: "est-high", evidenceClass: "estimated", scoreValue: 60, firstDetectedAt: at("2026-01-01") },
      { id: "tech", evidenceClass: "technical", scoreValue: 8, firstDetectedAt: at("2026-01-01") },
      { id: "meas-high", evidenceClass: "measured", scoreValue: 30, firstDetectedAt: at("2026-01-01") },
    ];
    expect(sortOpportunities(rows).map((row) => row.id)).toEqual([
      "meas-high",
      "meas-low",
      "est-high",
      "est-low",
      "tech",
      "hyp-high",
    ]);
  });

  it("keeps the class order the badge prints in step with the sort", () => {
    // A label that disagreed with the order would be worse than no label.
    expect([...EVIDENCE_CLASS_ORDER]).toEqual(["measured", "estimated", "technical", "hypothesis"]);
    const ranks = EVIDENCE_CLASS_ORDER.map((value) => evidenceClassRank(value));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("sorts an unrecognised class last rather than dropping the row", () => {
    // A row written by a future version, or with a null, must still appear.
    expect(evidenceClassRank("something_new")).toBe(EVIDENCE_CLASS_ORDER.length - 1);
    expect(evidenceClassRank(null)).toBe(EVIDENCE_CLASS_ORDER.length - 1);
  });

  it("still applies the score, the null rule and the tie-break inside a class", () => {
    const rows = [
      { id: "a", evidenceClass: "measured", scoreValue: 5, firstDetectedAt: at("2026-05-01") },
      { id: "b", evidenceClass: "measured", scoreValue: 5, firstDetectedAt: at("2026-01-01") },
      { id: "c", evidenceClass: "measured", scoreValue: null, firstDetectedAt: at("2026-01-01") },
      { id: "d", evidenceClass: "measured", scoreValue: 9, firstDetectedAt: at("2026-06-01") },
    ];
    expect(sortOpportunities(rows).map((row) => row.id)).toEqual(["d", "b", "a", "c"]);
  });
});

describe("the class is returned with the score, so writers cannot disagree", () => {
  function inputs(over: Partial<ScoreInputs["worth"]> = {}): ScoreInputs {
    return {
      worth: {
        change: "x",
        volume: 1300,
        intentFit: 0.35,
        readiness: "actionable",
        technical: false,
        windowDays: 28,
        measurement: "observed_baseline",
        targetPages: ["https://example.test/a"],
        benefitTrack: "organic_growth",
        intervention: "create_asset",
        volumeSource: "first_party",
        businessValue: 0.85,
        businessValueSource: "cluster",
        targetPosition: 10,
        currentPosition: 14,
        observedImpressions: 420,
        unmeasured: false,
        ...over,
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
  }

  it("names `measured` when the row has its own observed reach", () => {
    expect(computeScore(inputs()).evidenceClass).toBe("measured");
  });

  it("names `hypothesis` when there is too little reach to estimate a win", () => {
    // 3 impressions is not a small opportunity, it is no evidence of one.
    expect(computeScore(inputs({ observedImpressions: 3 })).evidenceClass).toBe("hypothesis");
  });

  it("names `technical` for a defect, whatever its demand", () => {
    expect(computeScore(inputs({ technical: true, severity: 0.6 })).evidenceClass).toBe("technical");
  });

  it("agrees with the assessment it was computed from", () => {
    // The column is a projection of `assessment.kind`; if these ever differ the board
    // is ordering by something other than the evidence.
    const result = computeScore(inputs());
    expect(result.evidenceClass).toBe(result.impact.kind);
  });
});
