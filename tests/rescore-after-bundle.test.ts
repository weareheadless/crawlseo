import { describe, expect, it, vi } from "vitest";

import { rescoreProjectOpportunities } from "@/lib/funnel/rescore";
import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

/**
 * The acceptance the issue asks for, stated as a scenario:
 *
 * > after a bundle adds impressions to a query that a row cites, the row's stored
 * > `scoreValue` changes without re-drafting the proposal
 *
 * The point is that no model call, no drafting and no new proposal is involved. The
 * row is the same row with the same identity and the same text; only its stored
 * `scoreInputs` were updated by the bundle, and the score follows them.
 */

/** The row as it was written: a content opportunity with no measured reach yet. */
function unmeasured(): ScoreInputs {
  return {
    worth: {
      change: "New Spanish article: apnea as a sport",
      volume: 1300,
      intentFit: 0.35,
      readiness: "actionable",
      technical: false,
      windowDays: 28,
      measurement: "unquantified",
      targetPages: ["https://inmersionfreediving.test/es/apnea"],
      benefitTrack: "organic_growth",
      intervention: "create_asset",
      volumeSource: "provider",
      businessValue: 0.55,
      businessValueSource: "cluster",
      targetPosition: 10,
      currentPosition: null,
      observedImpressions: 0,
      unmeasured: true,
    },
    effort: { sizeFactor: 1, playTypeBase: 8 },
    freshness: 0.9,
    stability: 0.8,
    evidenceCompleteness: "why",
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

/** The same row after the month's bundle: the page now has measured impressions. */
function measured(): ScoreInputs {
  const base = unmeasured();
  return {
    ...base,
    worth: {
      ...base.worth,
      measurement: "observed_baseline",
      observedImpressions: 4200,
      unmeasured: false,
      currentPosition: 14,
    },
    evidenceCompleteness: "both",
  } as unknown as ScoreInputs;
}

describe("when a bundle adds impressions, the stored score moves on its own", () => {
  it("re-scores the row from the updated inputs, with no drafting involved", async () => {
    const before = computeScore(unmeasured()).scoreValue;
    const expected = computeScore(measured()).scoreValue;

    // The row as stored: written when it was unmeasured, then its inputs updated by the
    // bundle. Its scoreValue is still the old one — that is the defect.
    const row = {
      id: "op-apnea",
      title: "New Spanish article: apnea as a sport",
      status: "detected",
      scoreValue: before,
      scoreInputs: measured(),
    };

    const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
    const db = {
      opportunity: {
        findMany: vi.fn(async () => [row]),
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push(args);
          return row;
        }),
      },
      site: { findMany: vi.fn(async () => []) },
    };

    const result = await rescoreProjectOpportunities(db as never, { projectId: "p1" });

    expect(result.changed).toBe(1);
    expect(updates[0].data.scoreValue).toBe(expected);
    expect(expected).not.toBe(before);
    // The identity and the text are untouched: this is the same opportunity, re-priced.
    expect(updates[0].where.id).toBe("op-apnea");
    expect(Object.keys(updates[0].data).sort()).toEqual(["lastScoredAt", "scoreValue"]);
  });

  it("moves it in the direction the evidence justifies", async () => {
    // Measured reach plus a complete evidence leg is strictly better grounded than the
    // same work with neither. If this ever inverts, the scorer is rewarding confidence
    // it does not have.
    const before = computeScore(unmeasured()).scoreValue;
    const after = computeScore(measured()).scoreValue;
    expect(after).toBeGreaterThan(before);
  });
});
